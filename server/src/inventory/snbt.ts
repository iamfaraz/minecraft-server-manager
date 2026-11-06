/**
 * Parser for SNBT, the text form of NBT that Java's `data get` prints, e.g.
 *   [{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:damage": 5}}]
 * Returns plain JavaScript values: compounds become objects, lists and typed arrays become arrays, numbers lose
 * their type suffix. That is all the inventory code needs; nothing is written back in this form.
 */
export function parseSnbt(text: string): any {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const fail = (what: string): never => {
    throw new Error(`SNBT: ${what} at ${i}: ${text.slice(Math.max(0, i - 20), i + 20)}`);
  };
  const quoted = (): string => {
    const q = text[i++];
    let out = '';
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') i++;
      out += text[i++];
    }
    if (text[i] !== q) fail('unterminated string');
    i++;
    return out;
  };
  const bare = (): string => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9_.+-]/.test(text[i])) i++;
    if (i === start) fail('unexpected character');
    return text.slice(start, i);
  };
  const scalar = (word: string): any => {
    if (word === 'true') return true;
    if (word === 'false') return false;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[bBsSlLfFdD]?$/.exec(word);
    return m ? Number(m[1]) : word;
  };
  const value = (): any => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, any> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare();
        ws();
        if (text[i++] !== ':') fail('expected :');
        obj[key] = value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (/^[BIL];/.test(text.slice(i, i + 2))) i += 2; // typed array marker
      const list: any[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return list;
      }
      for (;;) {
        list.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return list;
        }
        fail('expected , or ]');
      }
    }
    if (c === '"' || c === "'") return quoted();
    return scalar(bare());
  };
  const result = value();
  ws();
  if (i < text.length) fail('trailing text');
  return result;
}
