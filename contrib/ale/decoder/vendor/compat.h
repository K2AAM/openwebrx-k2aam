// OWRX adapter helpers. GPL-3.0-or-later.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <unistd.h>
#include <cstdarg>
#include <algorithm>
using u1_t=uint8_t; using u2_t=uint16_t; using u4_t=uint32_t; using s2_t=int16_t;
#define bf(v,hi,lo) (((v)>>(lo))&((1U<<((hi)-(lo)+1))-1))
#define b4(v) bf(v,4,4)
#define b13(v) bf(v,13,13)
#define b15(v) bf(v,15,15)
#define b20(v) bf(v,20,20)
#define ARRAY_LEN(a) (sizeof(a)/sizeof((a)[0]))
#define kiwi_snprintf_buf(buf,...) std::snprintf(buf,sizeof(buf),__VA_ARGS__)
inline int kiwi_snprintf_ptr(char* p,size_t capacity,const char* fmt,...) {
    va_list args; va_start(args,fmt); int n=std::vsnprintf(p,capacity,fmt,args); va_end(args);
    return n<0?0:std::min<int>(n,capacity?capacity-1:0);
}
void owrx_ale_text(const char*);
void owrx_ale_activity(bool);
inline int ext_send_msg(int,bool,const char* message,...) {
    if (std::strncmp(message,"EXT active=",11)==0)
        owrx_ale_activity(std::strcmp(message,"EXT active=0")!=0);
    return 0;
}
#define NextTask(s)
#include "ansi.h"
