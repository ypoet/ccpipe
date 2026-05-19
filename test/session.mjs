// Smoke test for the long-lived Session API.
import { Session } from "../dist/index.js";

const s = new Session();
await s.ready();
const r1 = await s.ask("记住一个数字：47。只回'好的'。");
console.log("R1:", r1.text);
const r2 = await s.ask("我刚才让你记住的数字是几？请只回数字。");
console.log("R2:", r2.text);
s.close();
