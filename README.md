# GenLayer P2P Lending Protocol

A peer-to-peer lending and borrowing Intelligent Contract for GenLayer, written in Python.
Lenders post loan offers in native GEN, borrowers take them by posting over-collateralized
GEN, and defaults are settled either by a deterministic deadline or by a validator-consensus
price oracle.

- Contract: `contracts/lending_protocol.py` (class `LendingProtocol`)
- Network: GenLayer Bradbury testnet
- Deployed address (v1.1.0): `0x6894FDA554e72179E067057495706cAfd5691E33`
- Earlier version v1.0.0 (superseded): `0x6d1eF034052c5455996829849bBE3aD97AA8c66A`
- Evidence and test results: see [TESTING.md](TESTING.md)

## How it works

1. **Offer.** A lender calls `create_offer` and sends the principal as value. The lender
   chooses the interest rate, duration, required collateral ratio, and an optional price
   trigger. The principal is held in escrow by the contract.
2. **Accept.** A borrower calls `accept_offer` and sends collateral (at least the required
   amount). The contract updates state first, then pays the principal to the borrower.
3. **Repay.** The borrower calls `repay` with at least principal + interest. The lender is
   paid, and the borrower gets the collateral back plus any overpayment.
4. **Default.** If the borrower does not repay, one of two liquidations applies:
   - `liquidate_overdue` (deterministic): callable by anyone after due date + grace period.
     The lender receives owed amount + penalty from the collateral; the borrower keeps the
     remainder.
   - `liquidate_by_price` (oracle): callable by the lender only, on loans that have a price
     trigger. Validators fetch the reference price independently and must agree before the
     liquidation can happen. The lender receives the owed amount (no penalty, because the
     borrower is not in default); the borrower keeps the remainder.
5. **Cancel.** A lender can cancel an offer nobody has accepted and get the principal back.

## Protocol parameters

| Parameter | Value |
|-----------|-------|
| Minimum collateral ratio | 150% (15000 bps) |
| Maximum interest | 20% flat for the whole term (2000 bps) |
| Overdue liquidation penalty | 5% of the repay amount (500 bps) |
| Duration | 600 seconds to 365 days |
| Grace period before overdue liquidation | 600 seconds |
| Oracle price tolerance between validators | 2% (200 bps) |
| Minimum principal | 10^12 wei |
| Price references | ETH, BTC, SOL (allowlist) |

Why these numbers: the worst case amount owed is 1.20 x 1.05 = 126% of principal, which is
always below the 150% minimum collateral. Collateral therefore covers every payout.

## Public methods

| Method | Type | Who | Description |
|--------|------|-----|-------------|
| `create_offer(interest_bps, duration, collateral_bps, min_price_e6, price_ref)` | write, payable | anyone | Post an offer; sent value is the principal |
| `cancel_offer(loan_id)` | write | lender | Cancel an open offer and refund the principal |
| `accept_offer(loan_id)` | write, payable | borrower | Post collateral and receive the principal |
| `repay(loan_id)` | write, payable | borrower | Repay principal + interest and reclaim collateral |
| `liquidate_overdue(loan_id)` | write | anyone | Settle a loan past due date + grace |
| `liquidate_by_price(loan_id)` | write | lender | Settle a loan when the oracle price is below the trigger |
| `set_paused(paused)` | write | owner | Pause new offers and new loans |
| `get_loan(loan_id)` | view | anyone | Full loan record |
| `get_loan_count()` | view | anyone | Number of loans (ids are 1-based) |
| `get_total_locked()` | view | anyone | Funds currently escrowed by the contract |
| `get_loans_by_lender(addr)` / `get_loans_by_borrower(addr)` | view | anyone | Loans for an address |
| `is_paused()` / `get_owner()` | view | anyone | Admin state |

Loan statuses: `open`, `active`, `repaid`, `liquidated`, `cancelled`.

## The oracle (Intelligent Contract part)

`liquidate_by_price` uses `gl.vm.run_nondet_unsafe` with a custom validator function. The
leader fetches the reference price from a fixed CoinGecko URL built from an allowlisted
asset and returns both the price and the liquidation decision (`price < trigger`). Every
validator fetches the price again on its own and accepts the leader only if all three
checks pass:

1. its own price is within 2% of the leader's price,
2. the leader's decision actually follows from the leader's own price, and
3. its own price reaches the same threshold outcome (same side of the loan's trigger).

Check 3 matters because two prices within 2% of each other can still sit on opposite sides
of a trigger. Without it a validator could approve a liquidation that its own price would
reject. Near the trigger the validators therefore disagree and the call fails closed
(no liquidation) instead of liquidating on a borderline price. This is a real numeric and
decision agreement check, not a format check.

Price references are chosen from an allowlist (ETH, BTC, SOL) and never built from free user
input, so users cannot point the oracle at arbitrary URLs.

**Important disclosure:** testnet GEN has no market price. The oracle therefore tracks a
reference asset (for example ETH) as the lender's price trigger. On this testnet deployment
it acts as a covenant on that reference price, not a true GEN valuation. A mainnet version
would use a price source for the actual collateral asset.

## Security design

- **Checks-effects-interactions.** Loan state is updated before any transfer is emitted.
- **Escrow accounting.** `locked` tracks every escrowed amount, and an unlock larger than
  the locked total aborts the transaction.
- **No double actions.** Every action checks the loan status, so a loan cannot be accepted,
  repaid, cancelled, or liquidated twice, and nothing can happen after closure.
- **Access control.** Only the lender can cancel or trigger price liquidation; only the
  borrower can repay; only the owner can pause. A lender cannot borrow their own offer.
- **Bounded parameters.** Interest, duration, collateral ratio, and principal are validated
  against fixed limits.
- **Pause cannot trap funds.** Pause only blocks new offers and new loans. Cancel, repay, and
  both liquidations keep working.
- **Settlement never exceeds collateral.** Seized amounts are capped at the collateral, and
  the remainder always goes to the borrower.

## Known limitations

- Testnet only and not audited.
- Interest is flat for the whole term (no accrual over time) and there are no partial repayments.
- The price oracle depends on a single public source (CoinGecko) and its rate limits.
- Collateral and loan are both native GEN, and the price trigger tracks a reference asset
  (see the disclosure above).
- Native GEN payouts are emitted with `emit_transfer`. On Bradbury these appear as Internal
  transfer messages in the explorer, but we observed in a separate investigation that
  emitted transfers on Bradbury and Asimov may not move wallet balances even though contract
  state updates correctly. Wallet balance settlement is therefore not claimed as verified;
  see TESTING.md, section 3, for how payouts are evidenced instead.

## Repository layout

```
contracts/lending_protocol.py   the Intelligent Contract
tests/test_lending.py           automated tests (gltest / pytest)
TESTING.md                      test plan, automated suite, on-chain evidence
README.md                       this file
```

## Deploy and run

1. Open GenLayer Studio and paste `contracts/lending_protocol.py` (the first line pins the
   runner version and must stay as the first line).
2. Deploy with no constructor arguments. The deployer becomes the owner.
3. Call `create_offer` with value (the principal) and the five arguments above.

Run the automated tests:

```
pip install genlayer-test pytest
gltest tests/test_lending.py
```
