from pycsdr.modules import ExecModule
from pycsdr.types import Format


class AleModule(ExecModule):
    def __init__(self):
        self.frequency = 0
        super().__init__(Format.SHORT, Format.CHAR, self._args())

    def _args(self):
        return ['owrx-ale', '--sample-rate', '8000',
                '--frequency-hz', str(self.frequency)]

    def setDialFrequency(self, frequency: int):
        if self.frequency != frequency:
            self.frequency = frequency
            self.setArgs(self._args())
            # Reset synchronization/partial words on every channel change.
            self.restart()
