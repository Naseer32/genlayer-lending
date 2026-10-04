# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

# TEST ONLY. No access control on purpose: deposit a tiny amount, send it back
# to your own wallet, and compare balances. Do not leave funds in it.
#
# deposit()                      payable, holds the GEN sent with the call
# send_default(to, amount)       emit_transfer with the default timing
# send_accepted(to, amount)      emit_transfer with on="accepted"
# amount is in wei (0.05 GEN = 50000000000000000)


class TransferProbe(gl.Contract):
    deposits: u256

    def __init__(self):
        self.deposits = u256(0)

    @gl.public.write.payable
    def deposit(self):
        self.deposits = u256(int(self.deposits) + int(gl.message.value))

    @gl.public.write
    def send_default(self, to: str, amount: int):
        gl.get_contract_at(Address(to)).emit_transfer(value=u256(int(amount)))

    @gl.public.write
    def send_accepted(self, to: str, amount: int):
        gl.get_contract_at(Address(to)).emit_transfer(
            value=u256(int(amount)), on="accepted"
        )

    @gl.public.view
    def get_deposits(self) -> int:
        return int(self.deposits)
