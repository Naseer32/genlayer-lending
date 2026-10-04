# Testing: GenLayer P2P Lending Protocol

- Contract: `contracts/lending_protocol.py` (class `LendingProtocol`)
- Current address (v1.1.0): `0x6894FDA554e72179E067057495706cAfd5691E33`
- Earlier address (v1.0.0, superseded): `0x6d1eF034052c5455996829849bBE3aD97AA8c66A`
- Network: GenLayer Bradbury Testnet
- Test dates: October 1 and 2, 2026

## 0. What changed in v1.1.0

Steward review of v1.0.0 found that the oracle consensus did not bind the liquidation
decision: a validator accepted the leader's price whenever it was within 2% of its own
price, but those two prices could sit on opposite sides of a loan's liquidation trigger, so
a validator could approve a liquidation that its own price would reject.

v1.1.0 fixes this in `liquidate_by_price` (function `_consensus_price_check`). The leader
returns both the price and the decision (`price < trigger`). Each validator accepts only if:

1. its own price is within 2% of the leader's price,
2. the leader's decision follows from the leader's own price, and
3. its own price reaches the same threshold outcome (same side of the trigger).

Near the trigger the validators therefore disagree and the call fails closed (no
liquidation). Nothing else in the contract changed.

## 1. Automated tests

File: `tests/test_lending.py` (20 test cases, gltest / pytest).

```
pip install genlayer-test pytest
gltest tests/test_lending.py
```

What they cover:

- Full lifecycle (create, accept, repay) and cancel, with escrow returning to zero
- Access control (only the lender cancels, only the borrower repays, only the owner pauses,
  lender cannot borrow their own offer)
- Collateral below the required amount, repayment below the amount owed
- Invalid offer parameters (interest above cap, duration too short, collateral ratio too low,
  dust principal, unsupported price reference)
- No double accept, repay, cancel, or liquidation, and no action after a loan is closed
- Early overdue liquidation rejected
- Price liquidation accepted when the price is below the trigger, rejected when above it,
  lender-only, and only when a trigger is set
- Pause blocks new offers and new loans but never blocks exits
- Unknown loan ids rejected

Latest run result (Studionet, hosted GenLayer Studio): all 20 tests passed. On a mobile
connection the suite was completed over several runs (connection drops and one 502 from the
hosted Studio interrupted some runs, and the affected tests were re-run on their own).
Every test passed, with no logic failures. On-chain evidence for Bradbury is in section 2.

Version note: the 16 non-oracle tests were run against v1.0.0. After the v1.1.0 change
(which only touches the oracle consensus function and `liquidate_by_price`), the 4 oracle
tests were re-run and all passed (`4 passed`).

The overdue liquidation path depends on real elapsed time (duration plus grace), so it is
evidenced on-chain in section 2 rather than in the automated suite.

## 2. On-chain evidence (Bradbury), current deployment v1.1.0

Address: `0x6894FDA554e72179E067057495706cAfd5691E33`. These two loans exercise the changed
oracle path with the new consensus check.

### Loan #1: oracle liquidation succeeds (price below trigger)

Offer created with `min_price_e6 = 1000000000000000` and `price_ref = "ETH"`, principal
1 GEN, collateral 2 GEN.

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0xe7fc1925180c63ecb0641ed8e65b7708de6a2c35953eb55911830dcb6e063076` | Created offer #1 |
| Accept offer | `0x77904298bd0bcb09f2e84c11c21b9737dd501665f5c9f7773e32e1b20c9135aa` | Accepted with 2 GEN collateral |
| Liquidate by price (lender) | `0x0e69fee99ce9c641ac1a47d23aaeffdd775e1e5e0e3e7d45e07d43b593637b47` | `get_loan(1)` showed `liquidated` and `last_price_e6 = 2662530000` (validators agreed on about 2662.53 USD) |

### Loan #2: oracle liquidation rejected (price above trigger)

Offer created with `min_price_e6 = 1` and `price_ref = "ETH"`, principal 1 GEN, collateral
2 GEN.

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0x1fbede701813426080ac5f30fdb13fc184db480c00223adbbc79706d49326122` | Created offer #2 |
| Accept offer | `0xe09110d1ef58b786be9d9d55aeb490406dd2a563fb4125a180871021d03ce76f` | Accepted with 2 GEN collateral |
| Liquidate by price (lender) | `0xe1b1d2fe05c6f4eb43808c8195418da083749cacd958dbae6db5945663ec0504` | Rolled back; `get_loan(2)` stayed `active` with `last_price_e6 = 0` |

Not covered on-chain: the cross-threshold case (leader and validator prices on opposite
sides of the trigger). It cannot be forced on a live network because it depends on real
market prices moving inside a 2% band around a trigger. It is covered by the design of the
validator function (check 3 above), not by a recorded transaction.

## 2b. Earlier deployment (v1.0.0, address `0x6d1eF034052c5455996829849bBE3aD97AA8c66A`)

Evidence from the first version. Everything except the price-liquidation tests (loans #5
and #6 below) exercises code that v1.1.0 did not change. Loans #5 and #6 are superseded by
the v1.1.0 evidence above.

Read calls such as `get_loan` and `get_total_locked` were used to verify state after each
step, but they do not produce transaction hashes and are not listed.

Note on statuses: in this environment a transaction can show consensus status "accepted"
together with an execution error. That means the validators agreed the call reverted, and all
state changes from it were rolled back. For these cases the evidence below also records the
loan state read afterward.

### Loan #1: happy path

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0x4bac95dfc831cbd00f966e16abfa70277b2f9b8699c685ecab9a7f12998245b2` | Created offer #1 |
| Accept offer (collateral too low) | `0xeb6c02c116bd96e3280841ee579dded12bacf1bf82615b5b7500416d772c8b98` | Sent 1 GEN against a required 1.5 GEN; execution error as expected, loan stayed open |
| Accept offer | `0x9192ce3ab545a82eaa4f5aac79ae1937a6e133076d14b68c37c6fcad135061e6` | Accepted with 2 GEN collateral |
| Repay | `0xb3b649b9e591f18a978cdec8ac25f70a0fc50781f672ce51f16c78cea14b8e8c` | `get_loan(1)` showed `repaid`; `get_total_locked()` returned 0 |

### Loan #2: cancel offer

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0xeffc46e71e45d8508da26cbc10e1cf9b52e0c8eae3628d5149f55722a1605c89` | Created open offer #2 |
| Cancel offer | `0x68b97c3b44ce60f2b4ac96adb79f343ce1c6d6daa122a0e1f590bb1de12b184c` | `get_loan(2)` showed `cancelled` |

### Loan #3: insufficient collateral protection

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0x8390acc046b3039205a4acf5b834faeec1b07a442ff33acea8afbbd46c84fa62` | Created open offer #3 |
| Accept with 1 GEN (below 1.5 GEN required) | `0x103cec9b79a82b68c2ce205d76f2f6e50411574e0e4f206a7b00a98772da5cd3` | Execution error; rejected |

### Loan #4: caller authorization and overdue liquidation

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0x0c639939c4733e1298e9be5af724986f4958ea93a7dba802741d5c4224abf3da` | Created offer #4 |
| Accept offer | `0x3b6df336ecc2114ca7bd0045a34a21c892e85db6611d74d373f773e513fa3ff3` | Accepted with 2 GEN collateral; loan became `active` |
| Repay from the wrong caller (lender) | `0x75ba10ad97e8573dcc8897a201e658cd162d9a534285f346fad1b15ef5360c1a` | Execution error; rejected |
| Overdue liquidation before the due time | `0xdffbbc140ce52ee692a2a48f73e0324c24ee20f5fe45a12f3751696857061697` | Execution error; rejected |
| Overdue liquidation after the due time | `0x3a05cdca8e93b8761a2d1455c0ec68b7abb05075a898f4a5512e120b96180030` | `get_loan(4)` showed `liquidated` |

### Loan #5: price-based liquidation (success)

Offer created with `min_price_e6 = 1000000000000000` and `price_ref = "ETH"`, so the
reference price is far below the trigger and liquidation is allowed.

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0x6fee071526737a34a07d28d4536e6136f8ae0f9fc23fefd91c4b810a089c543d` | Created offer #5 |
| Accept offer | not recorded | Accepted with 2 GEN collateral; `get_loan(5)` showed `active` |
| Liquidate by price (lender) | `0x6238818ba33017bb5f9aa4894c0d79d3324741649e458a9b26ad03181d85d6f7` | `get_loan(5)` showed `liquidated` and `last_price_e6 = 2730220000` (validators agreed on about 2730.22 USD) |

GenLayer chain transaction hash for the liquidation:
`0xe4464ecfce5cc977c291b09ee0353f1cb76d8f0fcd94c003bcba3914bd0b2c6c`

### Loan #6: price-based liquidation (rejected)

Offer created with `min_price_e6 = 1` and `price_ref = "ETH"`, so the price is above the
trigger and liquidation must be refused.

| Action | Transaction hash | Result |
|--------|------------------|--------|
| Create offer | `0xd8079215af8f7991b6f9bb038f5fe2aa3aef7668ceaf2485ff446bc80b438c98` | Created offer #6 |
| Accept offer | `0xfcd67d2576d595be1a9a8e09d17d9f7f7c5e0707cfd1f18c715054d875067670` | Accepted with 2 GEN collateral; `get_loan(6)` showed `active` |
| Liquidate by price (lender) | `0x0e1a7cf484db25ed7bf443fe2c1078f9b4378f342ab146a578faf7164cde8bce` | Execution error; `get_loan(6)` stayed `active` with `last_price_e6 = 0` |

GenLayer chain transaction hash for the rejected liquidation:
`0x5500fe286dc32fbd4a4b3ccd8423f5f372207a3376547a6b1953b29f3ef33d7b`

## 2c. Web app run on Studionet and the transfer probe

Studionet deployment of v1.1.0: `0x336b2962551BDea8C948Fd389d4e5C2EbB2969E5`, used through the
live web app (https://frontend-t3vl.vercel.app/, network switch set to Studionet).

| Action (through the app) | Transaction hash | Result |
|--------------------------|------------------|--------|
| Create offer, 1 GEN | `0x3b92ea24c86021c4a0a313379b9df4f6d82d4e0496198e5b67336796b802ccd9` | FINALIZED, GenVM result SUCCESS, return value 1 (loan #1 created) |
| Create offer, 13 GEN | `0x285a96da059299846292ae7e35b4d3357cdc077e05ed1a3fc37c99bf79f8568f` | Offer created, 13 GEN escrowed |
| Accept offer, 19.5 GEN collateral | `0x55bd11f4f6b4d3e048e3d3b00efc7d81241ea4e4f7571823afb7cf83a20ec965` | Loan became `active`; contract emitted the 13 GEN principal payout |
| Principal payout message (contract to borrower wallet, 13 GEN) | `0x9e33fa2be18457a0a811b73ebfe6a138323e45244d3f00913090f85a2f9bc767` | FINALIZED, but GenVM result Error; the borrower wallet balance did not increase |

What this showed: the contract state and the escrow side behaved as designed (loan active,
13 GEN left the contract, 19.5 GEN collateral stayed), and the payout message was addressed to
the correct wallet with the correct amount. The recipient balance did not increase.

Transfer probe (isolating the cause): `transfer_probe.py` is a 30-line contract that only
accepts a deposit and sends GEN back out with `emit_transfer` (default timing and
`on="accepted"`). Deployed on Studionet at `0xF720E02d2b2d1962e466E0a83c3293e70A5b128F`.
`deposit`, `send_default` and `send_accepted` all returned SUCCESS and each produced an emitted
message from the contract (shown by the explorer with GenVM result ERROR). The recipient
balance did not increase while the depositing wallet balance went down. The full transaction
list, with hashes, is on the probe contract page in the explorer.

Conclusion: emitted native transfers did not credit the recipient wallet, even in a minimal
contract that has nothing to do with lending. This points to network behaviour rather than the
protocol logic, and is why wallet-balance settlement is not claimed as verified anywhere in this
submission. The contract-side effects of every payout (status transitions, escrow counter,
the contract's own balance) are what is evidenced.

Also found during this run: the first version of the app guessed failures from the receipt
format and reported a successful `create_offer` as "rolled back". It now decides the outcome by
reading the contract state after each transaction (loan count or loan status).

## 3. Evidence notes and limits

- The explorer output did not expose the revert message for the rejected transactions. The
  contract raises specific errors for each case (for example "collateral below required
  amount", "only lender can trigger price liquidation", "loan not overdue yet", "price is
  above the liquidation trigger"). The loan state read afterward (unchanged status, and
  `last_price_e6` still 0 on loan #6) is consistent with a full rollback.
- Native GEN settlement on Bradbury: the contract emits its payouts with `emit_transfer`,
  and the explorer shows them as "Internal" transfer messages in the transaction (observed
  on the happy path and on the liquidations). In our separate investigation of another
  GenLayer contract on Bradbury and Asimov (same chain id), these emitted messages were
  recorded but the recipient wallet balance did not change, while the contract's own state
  updated correctly. This looks like a network-level limitation rather than a contract
  logic issue, and it also means the contract's own balance can read 0 in the explorer
  because funds entering a payable call are held by the network's escrow. For that reason
  this submission does not claim verified wallet-balance settlement. Payout correctness is
  evidenced by contract state instead: loan status transitions, `last_price_e6`, the
  `get_total_locked()` counter returning to 0 after loan #1, and the Internal transfer
  messages shown for each payout.
- The accept transaction hash for loan #5 was not recorded.
- Testnet GEN has no market price, so the price oracle tracks a reference asset (ETH here).
  This is a deliberate, disclosed design choice for the testnet deployment.
