// MakeCode (makecode.microbit.org) streamer — emits the SAME CSV line over BOTH
// USB serial AND Bluetooth Nordic UART, so one firmware serves both transports.
//   ax, ay, az, temperature-C, light-level, button-a, button-b
//
// TO USE:
//   1. New project at makecode.microbit.org, switch to JavaScript, paste this.
//   2. Adding `bluetooth.*` auto-installs the Bluetooth extension (it will ask
//      to remove the "radio" extension — allow it; they can't coexist).
//   3. Gear ▸ Project Settings ▸ set "No Pairing Required: Anyone can connect".
//      (Web Bluetooth + JustWorks = no passkey dance on the LED grid.)
//   4. Download ▸ flash via WebUSB. Board shows a heart when running.
//
// The USB `serial.writeLine` path keeps the existing js-file/Web Serial harness
// working unchanged; `bluetooth.uartWriteLine` adds the BLE path.

bluetooth.startUartService()
basic.showIcon(IconNames.Heart)

basic.forever(function () {
    const line =
        input.acceleration(Dimension.X) + "," +
        input.acceleration(Dimension.Y) + "," +
        input.acceleration(Dimension.Z) + "," +
        input.temperature() + "," +
        input.lightLevel() + "," +
        (input.buttonIsPressed(Button.A) ? 1 : 0) + "," +
        (input.buttonIsPressed(Button.B) ? 1 : 0)
    serial.writeLine(line)
    bluetooth.uartWriteLine(line)
    basic.pause(100)
})
