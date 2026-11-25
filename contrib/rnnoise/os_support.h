/* Stand-in for libopus's os_support.h, which RNNoise 0.2's portable (non-x86,
 * non-ARM) code path includes but the release does not ship. Only the macros
 * that path uses. */
#ifndef K2AAM_OS_SUPPORT_H
#define K2AAM_OS_SUPPORT_H
#include <string.h>
#include <stdlib.h>
#define OPUS_CLEAR(dst, n) (memset((dst), 0, (n)*sizeof(*(dst))))
#define OPUS_COPY(dst, src, n) (memcpy((dst), (src), (n)*sizeof(*(dst)) + 0*((dst)-(src)) ))
#define OPUS_MOVE(dst, src, n) (memmove((dst), (src), (n)*sizeof(*(dst)) + 0*((dst)-(src)) ))
#endif
