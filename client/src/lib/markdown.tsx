import type { ReactNode } from "react";

/**
 * Small, safe Markdown subset for policy pages: headings, paragraphs, lists,
 * **bold**, _italic_, `code` and [links](https://…). Produces React elements,
 * never raw HTML, so page content can't inject markup or scripts.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("_")) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("`")) out.push(<code key={key} className="rounded bg-subtle px-1 text-[0.9em]">{tok.slice(1, -1)}</code>);
    else {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const safe = /^(https?:\/\/|\/|mailto:)/i.test(href) ? href : "#";
      out.push(
        <a key={key} href={safe} className="text-primary underline" rel="noopener noreferrer" target={safe.startsWith("/") ? undefined : "_blank"}>
          {label}
        </a>,
      );
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`} className="mb-4 leading-relaxed">{inline(para.join(" "), `p${blocks.length}`)}</p>);
    if (list.length)
      blocks.push(
        <ul key={`u${blocks.length}`} className="mb-4 list-disc space-y-1 pl-6">
          {list.map((item, i) => (
            <li key={i}>{inline(item, `l${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
    para = [];
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      const size = h[1].length === 1 ? "text-2xl" : h[1].length === 2 ? "text-lg" : "text-base";
      const Tag = (`h${h[1].length}` as "h1" | "h2" | "h3");
      blocks.push(<Tag key={`h${blocks.length}`} className={`${size} mt-6 mb-3 font-semibold first:mt-0`}>{inline(h[2], `h${blocks.length}`)}</Tag>);
    } else if (/^[-*]\s+/.test(line)) {
      if (para.length) flush();
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (!line.trim()) flush();
    else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="text-sm text-fg">{blocks}</div>;
}
