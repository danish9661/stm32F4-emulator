void SystemClock_Config(void) {}

#define USART_SR  (*(volatile uint32_t *)0x40011000)
#define USART_DR  (*(volatile uint32_t *)0x40011004)
#define USART_BRR (*(volatile uint32_t *)0x40011008)
#define USART_CR1 (*(volatile uint32_t *)0x4001100C)

void setup(void) {
    volatile int i;
    // Direct USART1 config
    *(volatile uint32_t *)0x40023830 |= (1 << 0);  // RCC_AHB1ENR: GPIOA
    *(volatile uint32_t *)0x40023844 |= (1 << 4);  // RCC_APB2ENR: USART1
    *(volatile uint32_t *)0x40020000 = (*(volatile uint32_t *)0x40020000 & ~0xF) | 0xA;  // PA9 AF
    *(volatile uint32_t *)0x40020024 = (*(volatile uint32_t *)0x40020024 & ~0xF0) | 0x70; // PA10 AF
    USART_BRR = 16000000 / 115200;
    USART_CR1 = (1 << 13) | (1 << 3) | (1 << 2);  // UE, TE, RE
    for(i=0;i<100000;i++) __asm__("nop");
    USART_DR = 'H';
    for(i=0;i<100000;i++) __asm__("nop");
    USART_DR = 'i';
    for(i=0;i<100000;i++) __asm__("nop");
    USART_DR = '\r';
    for(i=0;i<100000;i++) __asm__("nop");
    USART_DR = '\n';
    for(i=0;i<100000;i++) __asm__("nop");
}

void loop(void) {}
