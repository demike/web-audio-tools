declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, bitrate: number);
    encodeBuffer(leftChannel: Int16Array, rightChannel?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}
