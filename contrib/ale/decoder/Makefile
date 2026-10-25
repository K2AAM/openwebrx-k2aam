CXX ?= c++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra
TARGET = owrx-ale
.PHONY: all clean
all: $(TARGET)
$(TARGET): main.cpp vendor/decode_ff_impl.cpp vendor/decode_ff_impl.h vendor/decode_ff.h vendor/compat.h vendor/ansi.h
	$(CXX) $(CXXFLAGS) -Ivendor main.cpp vendor/decode_ff_impl.cpp -o $@
clean:
	$(RM) $(TARGET)
