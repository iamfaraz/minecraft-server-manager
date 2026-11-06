/**
 * Reader and writer for Java's binary NBT (big-endian, as in player data files). Every tag keeps its exact type,
 * so a file that is read, changed in one place and written back is otherwise identical.
 */
export const enum T {
  End = 0,
  Byte = 1,
  Short = 2,
  Int = 3,
  Long = 4,
  Float = 5,
  Double = 6,
  ByteArray = 7,
  String = 8,
  List = 9,
  Compound = 10,
  IntArray = 11,
  LongArray = 12,
}

export type Tag =
  | { type: T.Byte | T.Short | T.Int | T.Float | T.Double; value: number }
  | { type: T.Long; value: bigint }
  | { type: T.String; value: string }
  | { type: T.ByteArray; value: Buffer }
  | { type: T.IntArray; value: number[] }
  | { type: T.LongArray; value: bigint[] }
  | { type: T.List; elementType: T; value: Tag[] }
  | { type: T.Compound; value: Map<string, Tag> };

export type Compound = Extract<Tag, { type: T.Compound }>;

export function readNbt(buf: Buffer): { name: string; root: Compound } {
  let o = 0;
  const str = () => {
    const len = buf.readUInt16BE(o);
    o += 2;
    const s = buf.toString('utf8', o, o + len);
    o += len;
    return s;
  };
  const payload = (type: T): Tag => {
    switch (type) {
      case T.Byte:
        return { type, value: buf.readInt8(o++) };
      case T.Short: {
        const v = buf.readInt16BE(o);
        o += 2;
        return { type, value: v };
      }
      case T.Int: {
        const v = buf.readInt32BE(o);
        o += 4;
        return { type, value: v };
      }
      case T.Long: {
        const v = buf.readBigInt64BE(o);
        o += 8;
        return { type, value: v };
      }
      case T.Float: {
        const v = buf.readFloatBE(o);
        o += 4;
        return { type, value: v };
      }
      case T.Double: {
        const v = buf.readDoubleBE(o);
        o += 8;
        return { type, value: v };
      }
      case T.ByteArray: {
        const len = buf.readInt32BE(o);
        o += 4;
        const v = Buffer.from(buf.subarray(o, o + len));
        o += len;
        return { type, value: v };
      }
      case T.String:
        return { type, value: str() };
      case T.List: {
        const elementType = buf.readUInt8(o++) as T;
        const len = buf.readInt32BE(o);
        o += 4;
        const value: Tag[] = [];
        for (let k = 0; k < len; k++) value.push(payload(elementType));
        return { type, elementType, value };
      }
      case T.Compound: {
        const value = new Map<string, Tag>();
        for (;;) {
          const t = buf.readUInt8(o++) as T;
          if (t === T.End) break;
          const name = str();
          value.set(name, payload(t));
        }
        return { type, value };
      }
      case T.IntArray: {
        const len = buf.readInt32BE(o);
        o += 4;
        const value: number[] = [];
        for (let k = 0; k < len; k++, o += 4) value.push(buf.readInt32BE(o));
        return { type, value };
      }
      case T.LongArray: {
        const len = buf.readInt32BE(o);
        o += 4;
        const value: bigint[] = [];
        for (let k = 0; k < len; k++, o += 8) value.push(buf.readBigInt64BE(o));
        return { type, value };
      }
      default:
        throw new Error(`NBT: unknown tag type ${type} at ${o}`);
    }
  };
  const rootType = buf.readUInt8(o++);
  if (rootType !== T.Compound) throw new Error('NBT: the file does not start with a compound');
  const name = str();
  return { name, root: payload(T.Compound) as Compound };
}

export function writeNbt(name: string, root: Compound): Buffer {
  const chunks: Buffer[] = [];
  const num = (size: number, write: (b: Buffer) => void) => {
    const b = Buffer.alloc(size);
    write(b);
    chunks.push(b);
  };
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    num(2, (x) => x.writeUInt16BE(b.length));
    chunks.push(b);
  };
  const payload = (tag: Tag) => {
    switch (tag.type) {
      case T.Byte:
        return num(1, (b) => b.writeInt8(tag.value));
      case T.Short:
        return num(2, (b) => b.writeInt16BE(tag.value));
      case T.Int:
        return num(4, (b) => b.writeInt32BE(tag.value));
      case T.Long:
        return num(8, (b) => b.writeBigInt64BE(tag.value));
      case T.Float:
        return num(4, (b) => b.writeFloatBE(tag.value));
      case T.Double:
        return num(8, (b) => b.writeDoubleBE(tag.value));
      case T.ByteArray:
        num(4, (b) => b.writeInt32BE(tag.value.length));
        return void chunks.push(tag.value);
      case T.String:
        return str(tag.value);
      case T.List:
        num(1, (b) => b.writeUInt8(tag.value.length ? tag.elementType : tag.elementType));
        num(4, (b) => b.writeInt32BE(tag.value.length));
        return tag.value.forEach(payload);
      case T.Compound:
        for (const [key, child] of tag.value) {
          num(1, (b) => b.writeUInt8(child.type));
          str(key);
          payload(child);
        }
        return num(1, (b) => b.writeUInt8(T.End));
      case T.IntArray:
        num(4, (b) => b.writeInt32BE(tag.value.length));
        return tag.value.forEach((v) => num(4, (b) => b.writeInt32BE(v)));
      case T.LongArray:
        num(4, (b) => b.writeInt32BE(tag.value.length));
        return tag.value.forEach((v) => num(8, (b) => b.writeBigInt64BE(v)));
    }
  };
  num(1, (b) => b.writeUInt8(T.Compound));
  str(name);
  payload(root);
  return Buffer.concat(chunks);
}

/** Tags as plain JavaScript values, for reading. Longs that fit become numbers. */
export function toPlain(tag: Tag): any {
  switch (tag.type) {
    case T.Compound:
      return Object.fromEntries([...tag.value].map(([k, v]) => [k, toPlain(v)]));
    case T.List:
      return tag.value.map(toPlain);
    case T.Long:
      return Number(tag.value);
    case T.LongArray:
      return tag.value.map(Number);
    case T.ByteArray:
      return [...tag.value];
    default:
      return tag.value;
  }
}

export const byte = (value: number): Tag => ({ type: T.Byte, value });
export const int = (value: number): Tag => ({ type: T.Int, value });
export const float = (value: number): Tag => ({ type: T.Float, value });
export const string = (value: string): Tag => ({ type: T.String, value });
export const compound = (entries: Record<string, Tag>): Compound => ({ type: T.Compound, value: new Map(Object.entries(entries)) });
