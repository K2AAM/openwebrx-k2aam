/* Minimal WebAssembly interface to RNNoise 0.2 for K2AAM NR.
 * One denoiser, fixed 480-sample (10 ms at 48 kHz) float buffers in the
 * module's memory: write k_in(), call k_process(), read k_out(). Samples are
 * in 16-bit scale (+-32768), as RNNoise expects. */
#include "rnnoise.h"
#include <stddef.h>

#define FRAME 480
static DenoiseState *st;
static float inbuf[FRAME], outbuf[FRAME];

__attribute__((export_name("k_frame"))) int k_frame(void) { return rnnoise_get_frame_size(); }
__attribute__((export_name("k_in"))) float *k_in(void) { return inbuf; }
__attribute__((export_name("k_out"))) float *k_out(void) { return outbuf; }
__attribute__((export_name("k_init"))) int k_init(void) {
    if (!st) st = rnnoise_create(NULL);
    return st != NULL;
}
__attribute__((export_name("k_reset"))) void k_reset(void) {
    if (st) rnnoise_init(st, NULL);
}
/* returns RNNoise's voice-activity probability for the frame */
__attribute__((export_name("k_process"))) float k_process(void) {
    return rnnoise_process_frame(st, outbuf, inbuf);
}
