"""
Automated tests for contracts/lending_protocol.py (LendingProtocol).

Run:
    gltest tests/test_lending.py --network studionet

Covers: happy path, cancel, access control, collateral checks, double-action
protection, price-trigger liquidation (accept and reject), pause behaviour,
input validation, and the invariant that escrow (get_total_locked) returns to
zero once every loan is closed.

Timing-dependent paths (overdue liquidation after due date + grace) are
documented in TESTING.md as on-chain evidence, because they need real waiting.
"""

import pytest
from gltest import get_contract_factory, get_accounts, get_default_account
from gltest.assertions import tx_execution_succeeded, tx_execution_failed

UNIT = 10**15  # 0.001 GEN
INTEREST_BPS = 500  # 5%
DURATION = 600
COLLATERAL_BPS = 15000  # 150%


@pytest.fixture(scope="module")
def accounts():
    others = [a for a in get_accounts() if a.address != get_default_account().address]
    return {
        "lender": get_default_account(),  # also the contract owner (deployer)
        "borrower": others[0],
        "stranger": others[1],
    }


@pytest.fixture()
def contract():
    factory = get_contract_factory("LendingProtocol")
    return factory.deploy(args=[])


def _send(contract, account, method, args, value=0):
    """Send a write transaction from a specific account."""
    bound = contract.connect(account)
    return getattr(bound, method)(args=args).transact(value=value)


def _count(contract):
    return contract.get_loan_count(args=[]).call()


def _locked(contract):
    return contract.get_total_locked(args=[]).call()


def _loan(contract, loan_id):
    return contract.get_loan(args=[loan_id]).call()


def _offer(contract, lender, amount=UNIT, interest=INTEREST_BPS,
           duration=DURATION, cbps=COLLATERAL_BPS, min_price=0, ref="NONE"):
    res = _send(
        contract, lender, "create_offer",
        [interest, duration, cbps, min_price, ref], amount,
    )
    assert tx_execution_succeeded(res)
    return _count(contract)


def _accept(contract, loan_id, borrower, collateral):
    return _send(contract, borrower, "accept_offer", [loan_id], collateral)


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------

def test_full_lifecycle_repay(contract, accounts):
    lender, borrower = accounts["lender"], accounts["borrower"]
    loan_id = _offer(contract, lender)
    assert loan_id == 1  # ids are 1-based
    loan = _loan(contract, loan_id)
    assert loan["status"] == "open"
    assert loan["required_collateral"] == UNIT * COLLATERAL_BPS // 10000
    assert _locked(contract) == UNIT

    res = _accept(contract, loan_id, borrower, loan["required_collateral"])
    assert tx_execution_succeeded(res)
    loan = _loan(contract, loan_id)
    assert loan["status"] == "active"
    assert _locked(contract) == loan["collateral"]

    owed = loan["repay_amount"]
    assert owed == UNIT + UNIT * INTEREST_BPS // 10000
    res = _send(contract, borrower, "repay", [loan_id], owed)
    assert tx_execution_succeeded(res)
    assert _loan(contract, loan_id)["status"] == "repaid"
    assert _locked(contract) == 0


def test_cancel_open_offer(contract, accounts):
    loan_id = _offer(contract, accounts["lender"])
    res = _send(contract, accounts["lender"], "cancel_offer", [loan_id])
    assert tx_execution_succeeded(res)
    assert _loan(contract, loan_id)["status"] == "cancelled"
    assert _locked(contract) == 0


# ---------------------------------------------------------------------------
# access control and validation
# ---------------------------------------------------------------------------

def test_only_lender_can_cancel(contract, accounts):
    loan_id = _offer(contract, accounts["lender"])
    res = _send(contract, accounts["stranger"], "cancel_offer", [loan_id])
    assert tx_execution_failed(res)
    assert _loan(contract, loan_id)["status"] == "open"


def test_lender_cannot_borrow_own_offer(contract, accounts):
    lender = accounts["lender"]
    loan_id = _offer(contract, lender)
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_failed(_accept(contract, loan_id, lender, required))


def test_low_collateral_rejected(contract, accounts):
    loan_id = _offer(contract, accounts["lender"])
    required = _loan(contract, loan_id)["required_collateral"]
    res = _accept(contract, loan_id, accounts["borrower"], required - 1)
    assert tx_execution_failed(res)
    assert _loan(contract, loan_id)["status"] == "open"


def test_only_borrower_can_repay(contract, accounts):
    loan_id = _offer(contract, accounts["lender"])
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(
        _accept(contract, loan_id, accounts["borrower"], required)
    )
    owed = _loan(contract, loan_id)["repay_amount"]
    res = _send(contract, accounts["stranger"], "repay", [loan_id], owed)
    assert tx_execution_failed(res)
    assert _loan(contract, loan_id)["status"] == "active"


def test_underpayment_rejected(contract, accounts):
    loan_id = _offer(contract, accounts["lender"])
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(
        _accept(contract, loan_id, accounts["borrower"], required)
    )
    owed = _loan(contract, loan_id)["repay_amount"]
    res = _send(contract, accounts["borrower"], "repay", [loan_id], owed - 1)
    assert tx_execution_failed(res)
    assert _loan(contract, loan_id)["status"] == "active"


@pytest.mark.parametrize(
    "interest,duration,cbps,amount",
    [
        (2001, DURATION, COLLATERAL_BPS, UNIT),  # interest above cap
        (INTEREST_BPS, 1, COLLATERAL_BPS, UNIT),  # duration too short
        (INTEREST_BPS, DURATION, 14999, UNIT),  # collateral ratio too low
        (INTEREST_BPS, DURATION, COLLATERAL_BPS, 1),  # dust principal
    ],
)
def test_invalid_offer_rejected(contract, accounts, interest, duration, cbps, amount):
    res = _send(
        contract, accounts["lender"], "create_offer",
        [interest, duration, cbps, 0, "NONE"], amount,
    )
    assert tx_execution_failed(res)
    assert _count(contract) == 0
    assert _locked(contract) == 0


# ---------------------------------------------------------------------------
# double-action protection (no double spend)
# ---------------------------------------------------------------------------

def test_no_double_accept_repay_or_cancel(contract, accounts):
    lender, borrower, stranger = (
        accounts["lender"], accounts["borrower"], accounts["stranger"],
    )
    loan_id = _offer(contract, lender)
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(_accept(contract, loan_id, borrower, required))

    # second accept and cancel after activation must fail
    assert tx_execution_failed(_accept(contract, loan_id, stranger, required))
    assert tx_execution_failed(_send(contract, lender, "cancel_offer", [loan_id]))

    owed = _loan(contract, loan_id)["repay_amount"]
    assert tx_execution_succeeded(_send(contract, borrower, "repay", [loan_id], owed))

    # everything after closure must fail
    assert tx_execution_failed(_send(contract, borrower, "repay", [loan_id], owed))
    assert tx_execution_failed(_send(contract, stranger, "liquidate_overdue", [loan_id]))
    assert tx_execution_failed(_send(contract, lender, "liquidate_by_price", [loan_id]))
    assert _locked(contract) == 0


def test_overdue_liquidation_too_early_rejected(contract, accounts):
    loan_id = _offer(contract, accounts["lender"])
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(
        _accept(contract, loan_id, accounts["borrower"], required)
    )
    res = _send(contract, accounts["stranger"], "liquidate_overdue", [loan_id])
    assert tx_execution_failed(res)
    assert _loan(contract, loan_id)["status"] == "active"


# ---------------------------------------------------------------------------
# oracle price liquidation (needs validators with internet access)
# ---------------------------------------------------------------------------

def test_price_liquidation_succeeds_when_below_trigger(contract, accounts):
    lender, borrower = accounts["lender"], accounts["borrower"]
    huge_trigger = 10**15  # far above any real price, so price < trigger
    loan_id = _offer(contract, lender, min_price=huge_trigger, ref="ETH")
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(_accept(contract, loan_id, borrower, required))

    res = _send(contract, lender, "liquidate_by_price", [loan_id])
    assert tx_execution_succeeded(res)
    loan = _loan(contract, loan_id)
    assert loan["status"] == "liquidated"
    assert loan["last_price_e6"] > 0
    assert _locked(contract) == 0


def test_price_liquidation_rejected_when_above_trigger(contract, accounts):
    lender, borrower = accounts["lender"], accounts["borrower"]
    loan_id = _offer(contract, lender, min_price=1, ref="ETH")
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(_accept(contract, loan_id, borrower, required))

    res = _send(contract, lender, "liquidate_by_price", [loan_id])
    assert tx_execution_failed(res)
    assert _loan(contract, loan_id)["status"] == "active"


def test_price_liquidation_only_lender_and_only_if_trigger_set(contract, accounts):
    lender, borrower, stranger = (
        accounts["lender"], accounts["borrower"], accounts["stranger"],
    )
    # no trigger set
    loan_id = _offer(contract, lender)
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_succeeded(_accept(contract, loan_id, borrower, required))
    assert tx_execution_failed(_send(contract, lender, "liquidate_by_price", [loan_id]))
    # trigger set but caller is not the lender
    loan_id2 = _offer(contract, lender, min_price=10**15, ref="ETH")
    required2 = _loan(contract, loan_id2)["required_collateral"]
    assert tx_execution_succeeded(_accept(contract, loan_id2, borrower, required2))
    assert tx_execution_failed(
        _send(contract, stranger, "liquidate_by_price", [loan_id2])
    )


def test_unsupported_price_reference_rejected(contract, accounts):
    res = _send(
        contract, accounts["lender"], "create_offer",
        [INTEREST_BPS, DURATION, COLLATERAL_BPS, 1000, "DOGE"], UNIT,
    )
    assert tx_execution_failed(res)


# ---------------------------------------------------------------------------
# pause
# ---------------------------------------------------------------------------

def test_pause_blocks_new_activity_but_not_exits(contract, accounts):
    lender, borrower = accounts["lender"], accounts["borrower"]
    loan_id = _offer(contract, lender)

    assert tx_execution_succeeded(_send(contract, lender, "set_paused", [True]))
    assert contract.is_paused(args=[]).call() is True

    # new offers and new loans are blocked
    res = _send(
        contract, lender, "create_offer",
        [INTEREST_BPS, DURATION, COLLATERAL_BPS, 0, "NONE"], UNIT,
    )
    assert tx_execution_failed(res)
    required = _loan(contract, loan_id)["required_collateral"]
    assert tx_execution_failed(_accept(contract, loan_id, borrower, required))

    # but the lender can always exit
    assert tx_execution_succeeded(_send(contract, lender, "cancel_offer", [loan_id]))
    assert _locked(contract) == 0


def test_only_owner_can_pause(contract, accounts):
    res = _send(contract, accounts["stranger"], "set_paused", [True])
    assert tx_execution_failed(res)


# ---------------------------------------------------------------------------
# views
# ---------------------------------------------------------------------------

def test_unknown_loan_rejected(contract):
    with pytest.raises(Exception):
        contract.get_loan(args=[999]).call()
    with pytest.raises(Exception):
        contract.get_loan(args=[0]).call()
