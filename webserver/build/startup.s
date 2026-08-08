.syntax unified
.thumb

.section .vector_table, "a"
.word _estack
.word _reset_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.word _default_handler
.rept 61
.word _default_handler
.endr
.word ETH_IRQHandler
.rept 19
.word _default_handler
.endr

.section .text
.global _reset_handler
.thumb_func
_reset_handler:
    ldr r0, =_sbss
    ldr r1, =_ebss
    mov r2, #0
bss_loop:
    cmp r0, r1
    bhs bss_done
    str r2, [r0]
    add r0, #4
    b bss_loop
bss_done:
    ldr r0, =_sdata
    ldr r1, =_edata
    ldr r2, =_sdata
data_loop:
    cmp r0, r1
    bhs data_done
    ldr r3, [r2]
    str r3, [r0]
    add r0, #4
    add r2, #4
    b data_loop
data_done:
    bl main
    b .

.global _default_handler
.thumb_func
_default_handler:
    b .
