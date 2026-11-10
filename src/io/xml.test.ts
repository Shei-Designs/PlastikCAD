import { describe, expect, it } from 'vitest';
import { XmlScanner, xmlTree } from './xml';

const encode = (text: string) => new TextEncoder().encode(text);

/** The attributes of the first tag of `text`. */
function attrsOf(text: string): Record<string, string> {
  const scanner = new XmlScanner(encode(text));
  scanner.next();
  return scanner.attrs();
}

describe('XmlScanner', () => {
  it('reads attributes in either quote, spaced any way, with their entities', () => {
    expect(attrsOf(`<a x="1" y='2'  xlink:href = "#b"\n\tname="a &amp; b &#65;&#x42; &unknown;" empty=""z="3"/>`)).toEqual({ x: '1', y: '2', 'xlink:href': '#b', name: 'a & b AB &unknown;', empty: '', z: '3' });
    // A quote of the other kind, a ">" and a "=" are all part of a value.
    expect(attrsOf(`<a d="it's > a=b" e='say "hi"'>`)).toEqual({ d: "it's > a=b", e: 'say "hi"' });
  });

  it('skips what is not an attribute and reads the ones after it', () => {
    expect(attrsOf('<a checked x="1" y=2 z = "3" =  "4" w="5>')).toEqual({ x: '1', z: '3' });
    expect(attrsOf('<a "x" y="1">')).toEqual({ y: '1' });
  });

  it('reads a tag with a very long run of text and no attribute in good time', () => {
    const started = performance.now();
    expect(attrsOf(`<svg ${'a'.repeat(300_000)}>`)).toEqual({});
    expect(attrsOf(`<svg ${'a '.repeat(150_000)}x="1">`)).toEqual({ x: '1' });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('xmlTree', () => {
  it('keeps the text of an element, without its comments and with its CDATA', () => {
    const root = xmlTree(encode('<a>one <!-- two --> <![CDATA[<three>]]> &lt;four&gt;<b/> five</a>'))!;
    expect(root.text).toBe('one  <three> <four> five');
    expect(root.children.map((c) => c.name)).toEqual(['b']);
  });

  it('reads text full of unfinished comments in good time', () => {
    const started = performance.now();
    const root = xmlTree(encode(`<a><![CDATA[${'<!--'.repeat(60_000)}]]><b/></a>`))!;
    expect(root.text.length).toBe(240_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a document nested deeper than any real one', () => {
    expect(xmlTree(encode(`${'<a>'.repeat(200)}${'</a>'.repeat(200)}`))!.name).toBe('a');
    expect(() => xmlTree(encode(`${'<a>'.repeat(100_000)}${'</a>'.repeat(100_000)}`))).toThrow(/nested too deeply/);
  });
});
