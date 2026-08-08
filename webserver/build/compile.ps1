$gcc = "C:\Users\Danish\AppData\Local\Arduino15\packages\STMicroelectronics\tools\xpack-arm-none-eabi-gcc\14.2.1-1.1\bin\arm-none-eabi-gcc"
$objcopy = "C:\Users\Danish\AppData\Local\Arduino15\packages\STMicroelectronics\tools\xpack-arm-none-eabi-gcc\14.2.1-1.1\bin\arm-none-eabi-objcopy"
$dir = "C:\Users\Danish\Documents\stm32-emulator-main\webserver\build"
$src = "C:\Users\Danish\Documents\stm32-emulator-main\webserver\webserver.ino"

# Assemble startup
& $gcc -mthumb -mcpu=cortex-m4 -c "$dir\startup.s" -o "$dir\startup.o"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Compile firmware
& $gcc -x c -mthumb -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard -Os -ffunction-sections -fdata-sections -c $src -o "$dir\webserver.o"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Link
$linkFlags = @(
    "-mthumb", "-mcpu=cortex-m4", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard"
    "-Os"
    "-Wl,--gc-sections"
    "-Wl,-Map,$dir\webserver.map"
    "-nostartfiles"
    "-T", "$dir\linker.ld"
    "-o", "$dir\webserver.elf"
    "$dir\startup.o"
    "$dir\webserver.o"
)
& $gcc @linkFlags
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Convert to binary
& $objcopy -O binary "$dir\webserver.elf" "$dir\webserver.bin"
Write-Host "OK: $(Get-Item $dir\webserver.bin | Select-Object -ExpandProperty Length) bytes"
