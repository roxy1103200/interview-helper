export const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
export function tokens(text: string): string[] {
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z0-9_+#.]+|[\p{Script=Han}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) =>
        /[\p{Script=Han}]/u.test(word)
          ? [...word].flatMap((_, i, chars) =>
              i + 1 < chars.length ? [chars[i] + chars[i + 1]] : chars.length === 1 ? [word] : [],
            )
          : [word],
      ),
    ),
  ];
}
export function isFiller(text: string) {
  const clean = normalize(text);
  return !clean || /^(嗯|啊|哦|好|好的|明白|行|是的|对|没问题|ok|okay)+$/i.test(clean);
}
export function isQuestion(text: string): boolean {
  if (isFiller(text)) return false;
  return (
    /[?？]|什么|为何|为什么|怎么|如何|哪些|多少|是否|能否|区别|原理|说说|讲讲|聊聊|说一下|讲一下|谈谈|谈一谈|简述|介绍|解释|设计|实现|举例|对比|分析|继续|然后呢|吗|呢/i.test(
      text,
    ) ||
    /(?:Java|JVM|JDK|Spring|MySQL|Redis|RabbitMQ|Kafka|HashMap|ConcurrentHashMap|ArrayList|LinkedList|ThreadLocal|volatile|synchronized|CAS|AQS|SQL|HTTP|TCP|UDP|HTTPS|RPC|CAP|ACID|B\+树|索引|事务|缓存|线程池|多线程|死锁|垃圾回收|类加载|双亲委派|乐观锁|悲观锁|分布式锁|幂等|消息队列|八股|RAG|MCP|LangGraph|Agent)/i.test(
      text,
    )
  );
}
export function parseLegacy(raw: string) {
  const entries: { title: string; keywords: string[]; answer: string }[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const at = line.indexOf('::');
    if (at >= 0) {
      const keywords = line
        .slice(0, at)
        .split('|')
        .map((v) => v.trim())
        .filter(Boolean);
      if (!keywords.length) throw new Error(`第 ${i + 1} 行缺少关键词`);
      entries.push({
        title: keywords[0],
        keywords,
        answer: line
          .slice(at + 2)
          .trim()
          .replace(/\\n/g, '\n'),
      });
    } else if (entries.length) entries.at(-1)!.answer += '\n' + line;
    else if (line.trim()) throw new Error(`第 ${i + 1} 行缺少“关键词 :: 答案”`);
  });
  if (entries.some((e) => !e.answer.trim())) throw new Error('存在空答案，请补全后再导入');
  return entries;
}
