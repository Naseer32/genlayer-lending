# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
from dataclasses import dataclass
import datetime
import json

# ---------------------------------------------------------------------------
# GenLayer P2P Lending Protocol (v1.0.0)
#
# - Lender escrows principal in native GEN via create_offer.
# - Borrower accepts by posting collateral (>= required) in native GEN.
# - Borrower repays principal + fixed interest to get collateral back.
# - Default path 1 (deterministic): after due date + grace, anyone can call
#   liquidate_overdue. Lender is paid from collateral (plus penalty).
# - Default path 2 (oracle): if the lender set a price trigger, the lender can
#   call liquidate_by_price. Validators independently fetch the reference
#   price and must agree within a tolerance before liquidation is allowed.
#
# Safety rules:
# - State is always updated BEFORE any transfer is emitted.
# - self.locked tracks escrowed funds; no payout can exceed it.
# - Interest is capped so that required collateral always covers
#   principal + interest + penalty (see constants below).
# - Pause only blocks NEW offers and NEW loans, never repay/cancel/liquidate.
# ---------------------------------------------------------------------------

BPS = 10000
MIN_COLLATERAL_BPS = 15000  # 150%
MAX_INTEREST_BPS = 2000  # 20% flat for the whole term
LIQUIDATION_PENALTY_BPS = 500  # 5% of repay amount, overdue liquidation only
# Check: (1 + 0.20) * (1 + 0.05) = 1.26 < 1.50, so collateral always covers.
MIN_DURATION = 600  # seconds
MAX_DURATION = 365 * 24 * 3600
GRACE_PERIOD = 600  # seconds after due date before overdue liquidation
PRICE_TOLERANCE_BPS = 200  # validators may differ by up to 2%
MIN_PRINCIPAL = 10**12  # wei, avoids dust loans

# Allowlisted price references (never build URLs from free user input).
ASSETS = {"ETH": "ethereum", "BTC": "bitcoin", "SOL": "solana"}


@allow_storage
@dataclass
class Loan:
    id: u256
    lender: Address
    borrower: Address
    principal: u256
    interest_bps: u256
    required_collateral: u256
    collateral: u256
    repay_amount: u256
    created_at: u256
    duration: u256
    due_at: u256
    min_price_e6: u256
    price_ref: str
    status: str  # open, active, repaid, liquidated, cancelled
    last_price_e6: u256


class LendingProtocol(gl.Contract):
    loans: DynArray[Loan]
    owner: Address
    paused: bool
    locked: u256

    def __init__(self):
        self.owner = gl.message.sender_address
        self.paused = False
        self.locked = u256(0)

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------

    def _now(self) -> int:
        raw = gl.message_raw["datetime"]
        dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return int(dt.timestamp())

    def _zero(self) -> Address:
        return Address("0x0000000000000000000000000000000000000000")

    def _get(self, loan_id: int) -> Loan:
        loan_id = int(loan_id)
        if loan_id < 1 or loan_id > len(self.loans):
            raise Exception("loan not found")
        return self.loans[loan_id - 1]

    def _lock(self, amount: int):
        self.locked = u256(int(self.locked) + amount)

    def _unlock(self, amount: int):
        if amount > int(self.locked):
            raise Exception("accounting error: unlock exceeds locked")
        self.locked = u256(int(self.locked) - amount)

    def _pay(self, to: Address, amount: int):
        if amount > 0:
            gl.get_contract_at(to).emit_transfer(value=u256(amount))

    def _seize(self, loan: Loan, owed: int):
        # Lender gets min(collateral, owed); borrower gets the remainder.
        collateral = int(loan.collateral)
        seize = min(collateral, owed)
        remainder = collateral - seize
        loan.status = "liquidated"
        self._unlock(collateral)
        self._pay(loan.lender, seize)
        self._pay(loan.borrower, remainder)

    def _fetch_price_e6(self, coin_id: str) -> int:
        url = (
            "https://api.coingecko.com/api/v3/simple/price?ids="
            + coin_id
            + "&vs_currencies=usd"
        )
        text = gl.nondet.web.render(url, mode="text")
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise Exception("price source returned no JSON")
        data = json.loads(text[start : end + 1])
        usd = float(data[coin_id]["usd"])
        price = int(round(usd * 1000000))
        if price <= 0:
            raise Exception("invalid price")
        return price

    def _consensus_price(self, price_ref: str) -> int:
        if price_ref not in ASSETS:
            raise Exception("unsupported price reference")
        coin_id = ASSETS[price_ref]

        def leader_fn():
            return self._fetch_price_e6(coin_id)

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            theirs = int(leader_result.calldata)
            try:
                mine = self._fetch_price_e6(coin_id)
            except Exception:
                return False
            if theirs <= 0 or mine <= 0:
                return False
            diff = abs(theirs - mine)
            return diff * BPS <= max(theirs, mine) * PRICE_TOLERANCE_BPS

        return int(gl.vm.run_nondet_unsafe(leader_fn, validator_fn))

    def _to_dict(self, loan: Loan) -> dict:
        return {
            "id": int(loan.id),
            "lender": loan.lender.as_hex,
            "borrower": loan.borrower.as_hex,
            "principal": int(loan.principal),
            "interest_bps": int(loan.interest_bps),
            "required_collateral": int(loan.required_collateral),
            "collateral": int(loan.collateral),
            "repay_amount": int(loan.repay_amount),
            "created_at": int(loan.created_at),
            "duration": int(loan.duration),
            "due_at": int(loan.due_at),
            "min_price_e6": int(loan.min_price_e6),
            "price_ref": loan.price_ref,
            "status": loan.status,
            "last_price_e6": int(loan.last_price_e6),
        }

    # ------------------------------------------------------------------
    # write methods
    # ------------------------------------------------------------------

    @gl.public.write.payable
    def create_offer(
        self,
        interest_bps: int,
        duration: int,
        collateral_bps: int,
        min_price_e6: int,
        price_ref: str,
    ) -> int:
        if self.paused:
            raise Exception("protocol paused")
        principal = int(gl.message.value)
        interest_bps = int(interest_bps)
        duration = int(duration)
        collateral_bps = int(collateral_bps)
        min_price_e6 = int(min_price_e6)
        ref = str(price_ref).strip().upper()

        if principal < MIN_PRINCIPAL:
            raise Exception("principal too small")
        if interest_bps < 0 or interest_bps > MAX_INTEREST_BPS:
            raise Exception("interest out of range")
        if duration < MIN_DURATION or duration > MAX_DURATION:
            raise Exception("duration out of range")
        if collateral_bps < MIN_COLLATERAL_BPS:
            raise Exception("collateral ratio below minimum")
        if min_price_e6 < 0:
            raise Exception("invalid price trigger")
        if min_price_e6 > 0:
            if ref not in ASSETS:
                raise Exception("unsupported price reference")
        else:
            ref = "NONE"

        loan_id = len(self.loans) + 1
        required = principal * collateral_bps // BPS
        repay = principal + principal * interest_bps // BPS

        self.loans.append(
            Loan(
                id=u256(loan_id),
                lender=gl.message.sender_address,
                borrower=self._zero(),
                principal=u256(principal),
                interest_bps=u256(interest_bps),
                required_collateral=u256(required),
                collateral=u256(0),
                repay_amount=u256(repay),
                created_at=u256(self._now()),
                duration=u256(duration),
                due_at=u256(0),
                min_price_e6=u256(min_price_e6),
                price_ref=ref,
                status="open",
                last_price_e6=u256(0),
            )
        )
        self._lock(principal)
        return loan_id

    @gl.public.write
    def cancel_offer(self, loan_id: int):
        loan = self._get(loan_id)
        if loan.status != "open":
            raise Exception("offer is not open")
        if gl.message.sender_address != loan.lender:
            raise Exception("only lender can cancel")
        principal = int(loan.principal)
        loan.status = "cancelled"
        self._unlock(principal)
        self._pay(loan.lender, principal)

    @gl.public.write.payable
    def accept_offer(self, loan_id: int):
        if self.paused:
            raise Exception("protocol paused")
        loan = self._get(loan_id)
        if loan.status != "open":
            raise Exception("offer is not open")
        sender = gl.message.sender_address
        if sender == loan.lender:
            raise Exception("lender cannot borrow own offer")
        collateral = int(gl.message.value)
        if collateral < int(loan.required_collateral):
            raise Exception("collateral below required amount")

        principal = int(loan.principal)
        now = self._now()
        loan.borrower = sender
        loan.collateral = u256(collateral)
        loan.due_at = u256(now + int(loan.duration))
        loan.status = "active"
        # escrow now holds collateral instead of principal
        self._unlock(principal)
        self._lock(collateral)
        self._pay(sender, principal)

    @gl.public.write.payable
    def repay(self, loan_id: int):
        loan = self._get(loan_id)
        if loan.status != "active":
            raise Exception("loan is not active")
        if gl.message.sender_address != loan.borrower:
            raise Exception("only borrower can repay")
        sent = int(gl.message.value)
        owed = int(loan.repay_amount)
        if sent < owed:
            raise Exception("repayment below amount owed")

        collateral = int(loan.collateral)
        overpay = sent - owed
        loan.status = "repaid"
        self._unlock(collateral)
        self._pay(loan.lender, owed)
        self._pay(loan.borrower, collateral + overpay)

    @gl.public.write
    def liquidate_overdue(self, loan_id: int):
        loan = self._get(loan_id)
        if loan.status != "active":
            raise Exception("loan is not active")
        if self._now() <= int(loan.due_at) + GRACE_PERIOD:
            raise Exception("loan not overdue yet")
        owed = int(loan.repay_amount)
        owed = owed + owed * LIQUIDATION_PENALTY_BPS // BPS
        self._seize(loan, owed)

    @gl.public.write
    def liquidate_by_price(self, loan_id: int):
        loan = self._get(loan_id)
        if loan.status != "active":
            raise Exception("loan is not active")
        if gl.message.sender_address != loan.lender:
            raise Exception("only lender can trigger price liquidation")
        trigger = int(loan.min_price_e6)
        if trigger == 0:
            raise Exception("no price trigger set on this loan")

        price = self._consensus_price(loan.price_ref)
        loan.last_price_e6 = u256(price)
        if price >= trigger:
            raise Exception("price is above the liquidation trigger")
        # Borrower is not in default: lender is made whole, no penalty.
        self._seize(loan, int(loan.repay_amount))

    @gl.public.write
    def set_paused(self, paused: bool):
        if gl.message.sender_address != self.owner:
            raise Exception("only owner")
        self.paused = bool(paused)

    # ------------------------------------------------------------------
    # views
    # ------------------------------------------------------------------

    @gl.public.view
    def get_loan(self, loan_id: int) -> dict:
        return self._to_dict(self._get(loan_id))

    @gl.public.view
    def get_loan_count(self) -> int:
        return len(self.loans)

    @gl.public.view
    def get_total_locked(self) -> int:
        return int(self.locked)

    @gl.public.view
    def is_paused(self) -> bool:
        return self.paused

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    @gl.public.view
    def get_loans_by_lender(self, lender: str) -> list:
        out = []
        target = str(lender).lower()
        for loan in self.loans:
            if loan.lender.as_hex.lower() == target:
                out.append(self._to_dict(loan))
        return out

    @gl.public.view
    def get_loans_by_borrower(self, borrower: str) -> list:
        out = []
        target = str(borrower).lower()
        for loan in self.loans:
            if loan.borrower.as_hex.lower() == target:
                out.append(self._to_dict(loan))
        return out
