import type { DataFormat } from "../../demo/main";


export function padTextureRowsToAlignment(
  data: DataFormat,
  width: number,
  height: number,
  bytesPerPixel: number,
  alignment: number = 4,
): { data: DataFormat; bytesPerRow: number; } {
  const rowBytes = width * bytesPerPixel;
  const bytesPerRow = Math.ceil(rowBytes / alignment) * alignment;

  if (bytesPerRow === rowBytes) {
    return { data, bytesPerRow };
  }

  const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dstBytes = new Uint8Array(bytesPerRow * height);

  for (let row = 0; row < height; row += 1) {
    dstBytes.set(src.subarray(row * rowBytes, (row + 1) * rowBytes), row * bytesPerRow);
  }

  return {
    data: data instanceof Uint16Array ? new Uint16Array(dstBytes.buffer)
      : data instanceof Float32Array ? new Float32Array(dstBytes.buffer)
        : dstBytes,
    bytesPerRow,
  };
}
