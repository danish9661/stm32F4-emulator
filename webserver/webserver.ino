#include <stdint.h>
void *memcpy(void *dst, const void *src, int n) { unsigned char *d=dst; const unsigned char *s=src; for(int i=0;i<n;i++) d[i]=s[i]; return dst; }
void *memset(void *s, int c, int n) { unsigned char *p=s; for(int i=0;i<n;i++) p[i]=(unsigned char)c; return s; }

// memset and memcpy from string.h (provided by compiler)

#define MACCR     (*(volatile uint32_t *)0x40028000)
#define MACFFR    (*(volatile uint32_t *)0x40028004)
#define MACMIIAR  (*(volatile uint32_t *)0x40028010)
#define MACMIIDR  (*(volatile uint32_t *)0x40028014)
#define MACPMTCSR (*(volatile uint32_t *)0x4002802C)
#define MACSR     (*(volatile uint32_t *)0x40028038)
#define MACA0HR   (*(volatile uint32_t *)0x40028040)
#define MACA0LR   (*(volatile uint32_t *)0x40028044)

#define DMABMR   (*(volatile uint32_t *)0x40029000)
#define DMATPDR  (*(volatile uint32_t *)0x40029004)
#define DMARPDR  (*(volatile uint32_t *)0x40029008)
#define DMARDLAR (*(volatile uint32_t *)0x4002900C)
#define DMATDLAR (*(volatile uint32_t *)0x40029010)
#define DMASR    (*(volatile uint32_t *)0x40029014)
#define DMAOMR   (*(volatile uint32_t *)0x40029018)
#define DMAIER   (*(volatile uint32_t *)0x4002901C)

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844)
#define NVIC_ISER1  (*(volatile uint32_t *)0xE000E104)

#define USART_SR  (*(volatile uint32_t *)0x40011000)
#define USART_DR  (*(volatile uint32_t *)0x40011004)
#define USART_BRR (*(volatile uint32_t *)0x40011008)
#define USART_CR1 (*(volatile uint32_t *)0x4001100C)

static const uint8_t our_mac[6] = {0x02, 0x00, 0x00, 0x00, 0x00, 0x01};
static const uint8_t gw_mac[6] = {0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd};

#define ETH_RX_DESC_CNT 4
#define ETH_TX_DESC_CNT 2
#define ETH_MAX_PKT 1536

static uint8_t rx_buf[ETH_RX_DESC_CNT][ETH_MAX_PKT] __attribute__((aligned(4)));
static uint8_t tx_pkt[ETH_MAX_PKT] __attribute__((aligned(4)));
static volatile uint32_t rx_desc[ETH_RX_DESC_CNT][2] __attribute__((aligned(8)));
static volatile uint32_t tx_desc[ETH_TX_DESC_CNT][2] __attribute__((aligned(8)));

static volatile uint32_t eth_irq_flag = 0;
static volatile uint32_t rx_frame_len = 0;
static volatile uint32_t rx_frame_idx = 0;
static uint8_t my_ip[4] = {0,0,0,0};
static uint32_t dhcp_xid = 0x87654321;

static void uart_init(void) {
    RCC_AHB1ENR |= (1 << 0); RCC_APB2ENR |= (1 << 4);
    *(volatile uint32_t *)0x40020000 = (*(volatile uint32_t *)0x40020000 & ~0xF) | 0xA;
    *(volatile uint32_t *)0x40020024 = (*(volatile uint32_t *)0x40020024 & ~0xF0) | 0x70;
    USART_BRR = 16000000 / 115200; USART_CR1 = (1 << 13) | (1 << 3) | (1 << 2);
}
static void uart_putchar(char c) { while (!(USART_SR & (1 << 7))); USART_DR = (uint8_t)c; }
static void uart_puts(const char *s) { while (*s) uart_putchar(*s++); }
static void uart_hex8(uint8_t v) { const char *h="0123456789ABCDEF"; uart_putchar(h[v>>4]); uart_putchar(h[v&0xF]); }
static void uart_ip(uint8_t *ip) { uart_putchar('0'+ip[0]/100); uart_putchar('0'+(ip[0]%100)/10); uart_putchar('0'+ip[0]%10); uart_putchar('.'); uart_putchar('0'+ip[1]/100); uart_putchar('0'+(ip[1]%100)/10); uart_putchar('0'+ip[1]%10); uart_putchar('.'); uart_putchar('0'+ip[2]/100); uart_putchar('0'+(ip[2]%100)/10); uart_putchar('0'+ip[2]%10); uart_putchar('.'); uart_putchar('0'+ip[3]/100); uart_putchar('0'+(ip[3]%100)/10); uart_putchar('0'+ip[3]%10); }
static void delay_ms(uint32_t ms) { for(uint32_t i=0;i<ms*4000;i++) __asm__("nop"); }

static uint16_t eth_phy_read(uint8_t phy, uint8_t reg) {
    MACMIIAR = (1<<0) | ((phy&0x1F)<<11) | ((reg&0x1F)<<6);
    for(int i=0;i<10000;i++){ if(!(MACMIIAR&1)) break; }
    return (uint16_t)MACMIIDR;
}

static void eth_init(void) {
    RCC_AHB1ENR |= (1<<25); uart_puts("ETH clock ON\r\n");
    DMABMR |= 1; delay_ms(2); uart_puts("DMA reset\r\n");
    MACCR = (1<<2)|(1<<3)|(1<<11); uart_puts("MAC RE+TE\r\n");
    MACA0HR = (our_mac[0]<<8)|our_mac[1]|(1<<31); MACA0LR = (our_mac[2]<<24)|(our_mac[3]<<16)|(our_mac[4]<<8)|our_mac[5]; uart_puts("MAC addr set\r\n");
    for(int i=0;i<100;i++){ if(eth_phy_read(0,1)&0x4){ uart_puts("link up\r\n"); break; } delay_ms(10); }
    DMAOMR = (1<<13)|(1<<1); uart_puts("DMA ST+SR\r\n");
}

static void eth_setup_rx(void) {
    for(int i=0;i<ETH_RX_DESC_CNT;i++){ rx_desc[i][0]=0x80000000|ETH_MAX_PKT; rx_desc[i][1]=(uint32_t)rx_buf[i]; }
    DMARDLAR = (uint32_t)rx_desc; DMARPDR = 1; uart_puts("RX descriptors ready\r\n");
}

static int eth_send_packet(const uint8_t *data, uint32_t len) {
    tx_desc[0][0] = 0x80000000|(1<<28)|(1<<27)|(len&0x3FFF);
    tx_desc[0][1] = (uint32_t)data;
    DMATDLAR = (uint32_t)tx_desc; DMATPDR = 1;
    for(int i=0;i<5000000;i++){ if(eth_irq_flag&1){ eth_irq_flag&=~1; return 1; } }
    return 0;
}

static int eth_recv_packet(uint8_t **buf, uint32_t *len) {
    uint32_t flag_val;
    for(int i=0;i<5000000;i++){
        flag_val = eth_irq_flag;
        if(flag_val&2){ eth_irq_flag&=~2; *buf=rx_buf[rx_frame_idx]; *len=rx_frame_len; rx_desc[rx_frame_idx][0]=0x80000000|ETH_MAX_PKT; DMARPDR=1; return 1; }
        if(flag_val&1){ eth_irq_flag&=~1; }
        if((i&0x3FF)==0) DMARPDR = 1;
    }
    return 0;
}

void ETH_IRQHandler(void) {
    uint32_t sr = DMASR;
    if(sr & 1)      { eth_irq_flag |= 1; DMASR = 0x10001; }
    if(sr & (1<<6)) { eth_irq_flag |= 2; DMASR = 1<<6; }
    for(int i=0;i<ETH_RX_DESC_CNT;i++){ if(!(rx_desc[i][0]&0x80000000)&&(rx_desc[i][0]&0x1FFFFFFF)){ rx_frame_idx=i; rx_frame_len=(rx_desc[i][0]>>16)&0x3FFF; break; } }
}

static uint16_t ones_cksum(const uint8_t *d, int n, uint32_t init) {
    uint32_t s = init;
    for(int i=0;i<n;i+=2) s += (d[i]<<8)|(i+1<n?d[i+1]:0);
    while(s>>16) s = (s&0xFFFF)+(s>>16);
    return (uint16_t)s;
}
static uint16_t ip_cksum(const uint8_t *h, int n) { return ~ones_cksum(h,n,0); }
static uint16_t tcp_cksum(const uint8_t *ip, const uint8_t *tcp, int tlen) {
    uint8_t ps[12];
    for(int i=0;i<8;i++) ps[i]=ip[12+i];
    ps[8]=0; ps[9]=ip[9]; ps[10]=(tlen>>8)&0xFF; ps[11]=tlen&0xFF;
    uint32_t s = ones_cksum(ps,12,0);
    s = ones_cksum(tcp,tlen,s);
    return ~(uint16_t)s;
}

static void build_ip_hdr(uint8_t *p, uint8_t proto, const uint8_t *dst, int total_len) {
    memset(p,0,20);
    p[0]=0x45; p[2]=(total_len>>8)&0xFF; p[3]=total_len&0xFF;
    p[8]=128; p[9]=proto;
    for(int i=0;i<4;i++) p[12+i]=my_ip[i];
    for(int i=0;i<4;i++) p[16+i]=dst[i];
    uint16_t ck = ip_cksum(p,20);
    p[10]=(ck>>8)&0xFF; p[11]=ck&0xFF;
}

static int build_tcp_frame(uint8_t flags, const uint8_t *payload, int plen,
                           const uint8_t *dst_mac, const uint8_t *dst_ip,
                           uint16_t dport, uint16_t sport,
                           uint32_t seq, uint32_t ack) {
    uint8_t *p = tx_pkt;
    memcpy(p, dst_mac, 6); p += 6;
    memcpy(p, our_mac, 6); p += 6;
    *p++ = 0x08; *p++ = 0x00;
    uint8_t *iph = p;
    int iplen = 20 + 20 + plen;
    build_ip_hdr(p, 6, dst_ip, iplen); p += 20;
    uint8_t *tcph = p;
    memset(p, 0, 20);
    p[0]=sport>>8; p[1]=sport&0xFF;
    p[2]=dport>>8; p[3]=dport&0xFF;
    p[4]=seq>>24; p[5]=seq>>16; p[6]=seq>>8; p[7]=seq;
    p[8]=ack>>24; p[9]=ack>>16; p[10]=ack>>8; p[11]=ack;
    p[12]=0x50; p[13]=flags;
    p[14]=0xFF; p[15]=0xFF;
    p+=20;
    if(payload&&plen>0){ memcpy(p,payload,plen); p+=plen; }
    int tlen = 20+plen;
    uint16_t ck = tcp_cksum(iph, tcph, tlen);
    tcph[16]=ck>>8; tcph[17]=ck&0xFF;
    iph[10]=0; iph[11]=0;
    ck = ip_cksum(iph, iplen);
    iph[10]=ck>>8; iph[11]=ck&0xFF;
    return (int)(p - tx_pkt);
}

static void build_dhcp(uint8_t *buf, uint32_t *len, uint8_t msg_type, uint32_t xid) {
    uint8_t *p = buf;
    memcpy(p, "\xff\xff\xff\xff\xff\xff", 6); p += 6;
    memcpy(p, our_mac, 6); p += 6;
    *p++ = 0x08; *p++ = 0x00;
    uint8_t *iph = p;
    *p++ = 0x45; *p++ = 0x00;
    uint8_t *lenp = p; p += 2;
    *p++ = 0x00; *p++ = 0x00; *p++ = 0x00; *p++ = 0x00;
    *p++ = 0x80; *p++ = 0x11;
    uint8_t *chkp = p; p += 2;
    *p++ = 0; *p++ = 0; *p++ = 0; *p++ = 0;
    *p++ = 255; *p++ = 255; *p++ = 255; *p++ = 255;
    uint8_t *udph = p;
    *p++ = 0x00; *p++ = 0x44; *p++ = 0x00; *p++ = 0x43;
    uint8_t *udplenp = p; p += 2;
    *p++ = 0x00; *p++ = 0x00;
    uint8_t *dhcpp = p;
    *p++ = 0x01; *p++ = 0x01; *p++ = 0x06; *p++ = 0x00;
    *p++ = (xid>>24)&0xFF; *p++ = (xid>>16)&0xFF; *p++ = (xid>>8)&0xFF; *p++ = xid&0xFF;
    *p++ = 0x00; *p++ = 0x00; *p++ = 0x00; *p++ = 0x00;
    for(int i=0;i<4;i++) *p++ = 0;
    for(int i=0;i<4;i++) *p++ = 0;
    for(int i=0;i<4;i++) *p++ = 0;
    for(int i=0;i<4;i++) *p++ = 0;
    memcpy(p, our_mac, 6); p += 6;
    for(int i=0;i<10;i++) *p++ = 0;
    for(int i=0;i<64;i++) *p++ = 0;
    for(int i=0;i<128;i++) *p++ = 0;
    *p++ = 0x63; *p++ = 0x82; *p++ = 0x53; *p++ = 0x63;
    *p++ = 53; *p++ = 1; *p++ = msg_type;
    *p++ = 12; *p++ = 4; *p++ = 's'; *p++ = 't'; *p++ = 'm'; *p++ = '3';
    *p++ = 255;
    for(int i=(p-dhcpp)%4;i>0&&i<4;i++) *p++ = 0;
    uint32_t udp_len = p - udph;
    udplenp[0]=(udp_len>>8)&0xFF; udplenp[1]=udp_len&0xFF;
    uint32_t ip_total = p - iph;
    lenp[0]=(ip_total>>8)&0xFF; lenp[1]=ip_total&0xFF;
    uint32_t sum = 0;
    for(int i=0;i<(int)ip_total;i+=2){ uint16_t w=(iph[i]<<8)|(i+1<(int)ip_total?iph[i+1]:0); sum+=w; }
    while(sum>>16) sum=(sum&0xFFFF)+(sum>>16);
    uint16_t cksum = ~(uint16_t)sum;
    chkp[0]=(cksum>>8)&0xFF; chkp[1]=cksum&0xFF;
    *len = p - buf;
    while(*len < 60){ *p++ = 0; (*len)++; }
}

static int parse_dhcp(uint8_t *buf, uint32_t len) {
    if(len<42||buf[12]!=0x08||buf[13]!=0x00) return 0;
    uint8_t *ip = buf+14;
    int ih = (ip[0]&0x0F)*4;
    if(ip[9]!=0x11) return 0;
    uint8_t *udp = ip+ih;
    if(((udp[0]<<8)|udp[1])!=67||((udp[2]<<8)|udp[3])!=68) return 0;
    uint8_t *dhcp = udp+8;
    uint32_t rxid = (dhcp[4]<<24)|(dhcp[5]<<16)|(dhcp[6]<<8)|dhcp[7];
    if(rxid!=dhcp_xid) return 0;
    for(int i=0;i<4;i++) my_ip[i]=dhcp[16+i];
    uint8_t mt=0;
    uint8_t *opt=dhcp+240; uint32_t o=0;
    while(opt[o]!=0xFF&&o<(len-((uint32_t)(opt-buf)))){
        if(opt[o]==53){ mt=opt[o+2]; break; }
        o+=opt[o+1]+2;
    }
    return mt;
}

static int handle_arp(uint8_t *pkt, uint32_t len) {
    if(len < 42) return 0;
    if(pkt[12]!=0x08||pkt[13]!=0x06) return 0;
    uint8_t *a = pkt + 14;
    if(a[0]!=0x00||a[1]!=0x01||a[2]!=0x08||a[3]!=0x00||a[4]!=6||a[5]!=4) return 0;
    if(a[6]!=0x00||a[7]!=0x01) return 0;
    if(a[24]!=my_ip[0]||a[25]!=my_ip[1]||a[26]!=my_ip[2]||a[27]!=my_ip[3]) return 0;
    uint8_t *p = tx_pkt;
    memcpy(p, pkt+6, 6); p += 6;
    memcpy(p, our_mac, 6); p += 6;
    *p++ = 0x08; *p++ = 0x06;
    *p++ = 0x00; *p++ = 0x01;
    *p++ = 0x08; *p++ = 0x00;
    *p++ = 6; *p++ = 4;
    *p++ = 0x00; *p++ = 0x02;
    memcpy(p, our_mac, 6); p += 6;
    *p++ = my_ip[0]; *p++ = my_ip[1]; *p++ = my_ip[2]; *p++ = my_ip[3];
    memcpy(p, pkt+6, 6); p += 6;
    *p++ = a[14]; *p++ = a[15]; *p++ = a[16]; *p++ = a[17];
    while((p - tx_pkt) < 60) *p++ = 0;
    eth_send_packet(tx_pkt, 60);
    return 1;
}

// ── TCP server state ──
static uint32_t srv_seq = 20000;
static uint32_t srv_ack = 0;
static uint8_t client_ip[4] = {0};
static uint8_t client_mac[6] = {0};
static uint16_t client_port = 0;
static int client_connected = 0;

static int tcp_accept(uint16_t listen_port) {
    for(int a=0;a<300;a++){
        uint8_t *pkt; uint32_t pl;
        if(!eth_recv_packet(&pkt,&pl)) continue;
        if(handle_arp(pkt,pl)) continue;
        if(pl<54||pkt[12]!=0x08||pkt[13]!=0x00) continue;
        uint8_t *ip2=pkt+14; int ih=(ip2[0]&0x0F)*4;
        if(ip2[9]!=6) continue;
        uint8_t *tcp2=ip2+ih;
        uint16_t dp=(tcp2[2]<<8)|tcp2[3];
        if(dp!=listen_port) continue;
        int fl=tcp2[13];
        uart_puts("TCP fl="); uart_hex8(fl); uart_puts(" port="); uart_hex8(dp>>8); uart_hex8(dp&0xFF); uart_puts("\r\n");
        if((fl&0x02) && !(fl&0x10)) { // SYN, no ACK
            client_port = (tcp2[0]<<8)|tcp2[1];
            for(int i=0;i<4;i++) client_ip[i]=ip2[12+i];
            for(int i=0;i<6;i++) client_mac[i]=pkt[i+6];
            uint32_t their_seq = (tcp2[4]<<24)|(tcp2[5]<<16)|(tcp2[6]<<8)|tcp2[7];
            srv_seq = 20000; srv_ack = their_seq + 1;
            int len = build_tcp_frame(0x12, 0, 0, client_mac, client_ip,
                                      client_port, listen_port, srv_seq, srv_ack);
            uart_puts("SYN-ACK\r\n");
            if(!eth_send_packet(tx_pkt, len)) return 0;
            srv_seq++;
            client_connected = 0;
            // Wait for ACK
            for(int b=0;b<100;b++){
                uint8_t *pkt2; uint32_t pl2;
                if(!eth_recv_packet(&pkt2,&pl2)) continue;
                if(handle_arp(pkt2,pl2)) continue;
                if(pl2<54||pkt2[12]!=0x08||pkt2[13]!=0x00) continue;
                uint8_t *ip3=pkt2+14; int ih3=(ip3[0]&0x0F)*4;
                if(ip3[9]!=6) continue;
                uint8_t *tcp3=ip3+ih3;
                uint16_t sp3=(tcp3[0]<<8)|tcp3[1], dp3=(tcp3[2]<<8)|tcp3[3];
                if(sp3!=client_port||dp3!=listen_port) continue;
                int fl3=tcp3[13];
                if(fl3==0x10){ // ACK
                    client_connected = 1;
                    uart_puts("Client ACK\r\n");
                    return 1;
                }
            }
            uart_puts("ACK timeout\r\n");
            return 0;
        }
    }
    return 0;
}

static int tcp_server_recv(uint8_t **buf, uint32_t *len) {
    for(int a=0;a<200;a++){
        uint8_t *pkt; uint32_t pl;
        if(!eth_recv_packet(&pkt,&pl)) continue;
        if(handle_arp(pkt,pl)) continue;
        if(pl<54||pkt[12]!=0x08||pkt[13]!=0x00) continue;
        uint8_t *ip2=pkt+14; int ih=(ip2[0]&0x0F)*4;
        if(ip2[9]!=6) continue;
        uint8_t *tcp2=ip2+ih;
        uint16_t sp=(tcp2[0]<<8)|tcp2[1], dp=(tcp2[2]<<8)|tcp2[3];
        if(sp!=client_port||dp!=80) continue;
        int fl=tcp2[13];
        int th=((tcp2[12]>>4)&0x0F)*4;
        int td=pl-14-ih-th;
        if(td<0) td=0;
        uint32_t rseq=(tcp2[4]<<24)|(tcp2[5]<<16)|(tcp2[6]<<8)|tcp2[7];
        *buf=tcp2+th; *len=td;
        srv_ack = rseq + td;
        if(fl&1){ srv_ack++; client_connected=0; uart_puts("CLIENT FIN\r\n"); }
        int len2 = build_tcp_frame(0x10, 0, 0, client_mac, client_ip,
                                   client_port, 80, srv_seq, srv_ack);
        if(!eth_send_packet(tx_pkt, len2)) return -1;
        if(td>0) return td;
        if(fl&1) return 0;
    }
    return -2;
}

static int tcp_server_send(const uint8_t *data, int dlen) {
    if(!client_connected) return 0;
    int len = build_tcp_frame(0x18, data, dlen, client_mac, client_ip,
                              client_port, 80, srv_seq, srv_ack);
    if(!eth_send_packet(tx_pkt, len)) return 0;
    srv_seq += dlen;
    return 1;
}

static void tcp_server_close(void) {
    int len = build_tcp_frame(0x11, 0, 0, client_mac, client_ip,
                              client_port, 80, srv_seq, srv_ack);
    eth_send_packet(tx_pkt, len);
    srv_seq++;
    client_connected = 0;
    uart_puts("FIN\r\n");
}

static int strlen_c(const char *s) { int n=0; while(s[n]) n++; return n; }

void setup(void) {
    uart_init();
    uart_puts("\r\n=== Web Server ===\r\n");
    eth_init(); eth_setup_rx();
    NVIC_ISER1 |= (1<< (61-32));
    DMAIER = (1<<16)|(1<<0)|(1<<6);
    uart_puts("Ready\r\n");
}

void loop(void) {
    uint8_t *pkt; uint32_t pl;

    // DHCP
    uart_puts("DHCP Discover\r\n");
    build_dhcp(tx_pkt, &pl, 1, dhcp_xid);
    if(!eth_send_packet(tx_pkt, pl)){ uart_puts("DHCP TX timeout\r\n"); return; }
    uart_puts("Wait DHCP Offer\r\n");
    int dhcp_ok=0;
    for(int a=0;a<30;a++){
        if(!eth_recv_packet(&pkt,&pl)) continue;
        int mt=parse_dhcp(pkt,pl);
        if(mt==2){
            uart_puts("Offer IP="); uart_ip(my_ip); uart_puts("\r\n");
            build_dhcp(tx_pkt,&pl,3,dhcp_xid);
            if(!eth_send_packet(tx_pkt,pl)){ uart_puts("Req TX timeout\r\n"); return; }
        } else if(mt==5){
            uart_puts("DHCP Ack IP="); uart_ip(my_ip); uart_puts(" OK\r\n");
            dhcp_ok=1; break;
        }
    }
    if(!dhcp_ok){ uart_puts("DHCP failed\r\n"); return; }

    uart_puts("Listening on port 80\r\n");

    while(1){
        uart_puts("Waiting for client...\r\n");
        if(!tcp_accept(80)){ uart_puts("Accept timeout\r\n"); continue; }

        // Receive HTTP request
        uart_puts("REQ:\r\n");
        int total=0;
        while(1){
            uint8_t *data; uint32_t dl;
            int r=tcp_server_recv(&data,&dl);
            if(r==-2){ uart_puts("[TIMEOUT]\r\n"); break; }
            if(r==-1){ uart_puts("R=-1\r\n"); break; }
            if(r>0){ for(uint32_t i=0;i<dl;i++) uart_putchar((char)data[i]); total+=dl; }
            if(!client_connected) break;
            if(r==0) break;
            if(total>500) break;
        }
        uart_puts("\r\n");

        // Send HTTP response
        const char *resp =
            "HTTP/1.0 200 OK\r\n"
            "Content-Type: text/html\r\n"
            "Connection: close\r\n"
            "\r\n"
            "<!DOCTYPE html>\r\n"
            "<html><head><title>STM32 Web Server</title></head>\r\n"
            "<body>\r\n"
            "<h1>Hello from STM32F407!</h1>\r\n"
            "<p>This is running on an emulated STM32F407VGT6 via Unicorn</p>\r\n"
            "<p>IP: ";
        char ipbuf[20];
        int ipn=0;
        ipbuf[ipn++]='0'+my_ip[0]/100; ipbuf[ipn++]='0'+(my_ip[0]%100)/10; ipbuf[ipn++]='0'+my_ip[0]%10; ipbuf[ipn++]='.';
        ipbuf[ipn++]='0'+my_ip[1]/100; ipbuf[ipn++]='0'+(my_ip[1]%100)/10; ipbuf[ipn++]='0'+my_ip[1]%10; ipbuf[ipn++]='.';
        ipbuf[ipn++]='0'+my_ip[2]/100; ipbuf[ipn++]='0'+(my_ip[2]%100)/10; ipbuf[ipn++]='0'+my_ip[2]%10; ipbuf[ipn++]='.';
        ipbuf[ipn++]='0'+my_ip[3]/100; ipbuf[ipn++]='0'+(my_ip[3]%100)/10; ipbuf[ipn++]='0'+my_ip[3]%10;

        uart_puts("Sending response...\r\n");
        tcp_server_send((const uint8_t*)resp, strlen_c(resp));
        tcp_server_send((const uint8_t*)ipbuf, ipn);
        const char *tail = "</p></body></html>\r\n";
        tcp_server_send((const uint8_t*)tail, strlen_c(tail));
        uart_puts("Done\r\n");
        tcp_server_close();
    }
}

int main(void) { setup(); while(1) loop(); }
