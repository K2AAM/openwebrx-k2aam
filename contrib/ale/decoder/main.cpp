// OWRX receive-only ALE adapter. SPDX-License-Identifier: GPL-3.0-or-later
#include "vendor/compat.h"
#include "vendor/decode_ff_impl.h"
#include <iostream>
#include <string>
#include <regex>
#include <memory>

static uint64_t samples_processed=0;
static uint64_t dial_frequency=0;
static std::string json(const std::string& s) {
    std::string out="\"";
    for (unsigned char c:s) {
        if (c=='"'||c=='\\') {out+='\\';out+=c;}
        else if (c<32||c>=127) {char b[7];std::snprintf(b,sizeof(b),"\\u%04x",c);out+=b;}
        else out+=c;
    }
    return out+'"';
}
static std::string field(const std::string& s,const char* pattern) {
    std::smatch m;return std::regex_search(s,m,std::regex(pattern))?m[1].str():"";
}
void owrx_ale_activity(bool active) {
    std::cout<<"{\"kind\":\"activity\",\"active\":"<<(active?"true":"false")
             <<",\"frequency_hz\":"<<dial_frequency<<",\"sample_seconds\":"<<samples_processed/8000.0<<"}"<<std::endl;
}
void owrx_ale_text(const char* line) {
    std::string text=std::regex_replace(line,std::regex("\x1b\\[[0-9;]*m"),"");
    while (!text.empty()&&(text.back()=='\n'||text.back()=='\r'))text.pop_back();
    std::string event="command";
    if (text.find("[Sounding THIS WAS]")!=std::string::npos)event="sounding_this_was";
    else if (text.find("[Sounding THIS IS]")!=std::string::npos)event="sounding_this_is";
    else if (text.find("[Call EST]")!=std::string::npos)event="call_established";
    else if (text.find("[Call ACK]")!=std::string::npos)event="call_ack";
    else if (text.find("[Call]")!=std::string::npos)event="call";
    else if (text.find("[To:")!=std::string::npos)event="destination";
    else if (text.find("AMD:")!=std::string::npos)event="amd";
    else if (text.find("DTM:")!=std::string::npos)event="dtm";
    std::cout<<"{\"kind\":\"decode\",\"event\":"<<json(event)
        <<",\"source\":"<<json(field(text,"\\[From: (.*?)\\]"))
        <<",\"destination\":"<<json(field(text,"\\[To: (.*?)\\]"))
        <<",\"display\":"<<json(text)
        <<",\"frequency_hz\":"<<dial_frequency<<",\"sample_seconds\":"<<samples_processed/8000.0<<"}"<<std::endl;
}
int main(int argc,char** argv) {
    for(int i=1;i<argc;i++) {
        std::string arg=argv[i];
        if(arg=="--version") {std::cout<<"owrx-ale 0.1.0"<<std::endl;return 0;}
        if(arg=="--help") {std::cout<<"owrx-ale [--sample-rate 8000]\nInput: mono signed 16-bit little-endian PCM on stdin. Output: JSON Lines.\n";return 0;}
        if(arg=="--sample-rate"&&i+1<argc&&std::string(argv[++i])=="8000")continue;
        if(arg=="--frequency-hz"&&i+1<argc) {
            std::string value=argv[++i];
            if(value.empty()||value.find_first_not_of("0123456789")!=std::string::npos||value.size()>10) {
                std::cerr<<"Invalid frequency.\n";return 2;
            }
            dial_frequency=std::stoull(value);continue;
        }
        std::cerr<<"Unsupported argument or sample rate; use --help.\n";return 2;
    }
    auto decoder=std::make_unique<ale::decode_ff_impl>();
    decoder->modem_init(0,false,8000,32,false);decoder->set_display(1);
    unsigned char bytes[64];float samples[32];
    while(std::cin.read(reinterpret_cast<char*>(bytes),sizeof(bytes))||std::cin.gcount()) {
        const auto n=std::cin.gcount();
        if(n%2) {std::cerr<<"Truncated 16-bit PCM sample.\n";return 2;}
        for(int i=0;i<n/2;i++) {
            const uint16_t value=uint16_t(bytes[2*i])|(uint16_t(bytes[2*i+1])<<8);
            samples[i]=value<32768?float(value):float(int(value)-65536);
        }
        samples_processed+=n/2;decoder->do_modem(samples,n/2);
    }
    if(std::cin.bad()) {std::cerr<<"PCM input failed.\n";return 2;}
    decoder->finish();return std::cout.good()?0:1;
}
