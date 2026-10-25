from csdr.chain.demodulator import ServiceDemodulator, DialFrequencyReceiver
from csdr.module.ale import AleModule
from owrx.ale import AleParser
from pycsdr.modules import Convert
from pycsdr.types import Format


class AleDemodulator(ServiceDemodulator, DialFrequencyReceiver):
    def __init__(self):
        self.parser = AleParser()
        self.decoder = AleModule()
        super().__init__([Convert(Format.FLOAT, Format.SHORT), self.decoder, self.parser])

    def getFixedAudioRate(self):
        return 8000

    def supportsSquelch(self):
        return False

    def isSecondaryFftShown(self):
        return False

    def setDialFrequency(self, frequency: int):
        frequency = int(round(frequency))
        self.parser.setDialFrequency(frequency)
        self.decoder.setDialFrequency(frequency)
