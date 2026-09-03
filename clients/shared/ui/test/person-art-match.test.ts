/**
 * 人员形象的性别不变量（2026-09-02 走查：车机人员档案里"玉米 · 儿子"是张女孩的脸）。
 *
 * 这类 bug 的特征是**只看代码挑不出毛病**——"孩子就用孩子的图"读起来很合理，
 * 错的是素材只有女儿那一张。所以断言锁的是"关系 → 性别 → 素材"这条链，
 * 不是"某个关系有没有图"：只锁后者的话，把儿子接回女儿的图照样全绿。
 *
 * 贴图表（`profile-characters.ts`）import png，node --test 起不来，所以这里测的是
 * 纯逻辑那一半；两边对不上会被"每个 key 都有素材文件"那条断言抓到。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { inferPersonGender, personArtKey, type PersonArtKey } from "../src/vehicle/person-art-match";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 每个 key 对应的性别——素材本身是什么性别，改素材要同步改这里。 */
const KEY_GENDER: Record<PersonArtKey, "male" | "female"> = {
  owner: "male",
  spouse: "female",
  mother: "female",
  daughter: "female",
  son: "male",
};

describe("人员形象：按关系选脸", () => {
  it("儿子拿到男孩、女儿拿到女孩——这是走查报出来的那条", () => {
    assert.equal(personArtKey({ displayName: "玉米", relation: "儿子" }), "son");
    assert.equal(personArtKey({ displayName: "小满", relation: "女儿" }), "daughter");
  });

  it("关系写在称呼里也认（很多人不填 relation）", () => {
    assert.equal(personArtKey({ displayName: "妈妈" }), "mother");
    assert.equal(personArtKey({ displayName: "老婆", relation: "配偶" }), "spouse");
    assert.equal(personArtKey({ displayName: "儿子" }), "son");
  });

  it("性别对不上就不给图，绝不退而求其次派一张相反性别的脸", () => {
    // 本批素材没有"丈夫"。给女车主的老公配上妻子那张脸，就是走查报的同一个 bug 换个方向。
    assert.equal(personArtKey({ displayName: "老公", relation: "丈夫" }), undefined);
    assert.equal(personArtKey({ displayName: "爸爸", relation: "父亲" }), undefined);
  });

  it("性别判不出来而候选跨性别时不给图（'孩子'既可能是儿子也可能是女儿）", () => {
    assert.equal(personArtKey({ relation: "孩子" }), undefined);
    assert.equal(personArtKey({ relation: "小孩" }), undefined);
  });

  it("完全匹配不到的关系不给图", () => {
    for (const relation of ["朋友", "同事", "保姆", "司机", "爷爷", ""]) {
      assert.equal(personArtKey({ displayName: "张三", relation }), undefined, relation);
    }
  });

  it("字面性别与实际相反的叫法按最长匹配判，不被短词抢走", () => {
    assert.equal(inferPersonGender("外孙女"), "female"); // 含"外孙"（男）
    assert.equal(inferPersonGender("女婿"), "male"); // 含"女"
    assert.equal(inferPersonGender("儿媳"), "female"); // 含"儿"
    assert.equal(inferPersonGender("孙女"), "female");
  });

  it("每个 key 选出来的性别与素材性别一致（这条防的是「接错线」）", () => {
    const cases: Array<[string, PersonArtKey]> = [
      ["本人", "owner"],
      ["妻子", "spouse"],
      ["母亲", "mother"],
      ["女儿", "daughter"],
      ["儿子", "son"],
    ];
    for (const [relation, key] of cases) {
      assert.equal(personArtKey({ relation }), key, relation);
      const g = inferPersonGender(relation);
      // "本人"判不出性别（车主可能是任何人），其余必须与素材性别一致
      if (g) assert.equal(g, KEY_GENDER[key], `${relation} 的性别与 ${key} 素材对不上`);
    }
  });
});

describe("人员形象：key 与素材文件", () => {
  const table = readFileSync(path.join(SRC, "vehicle", "profile-characters.ts"), "utf8");

  it("每个 key 在贴图表里都有一行，且 light/dark 两张文件都在", () => {
    // 贴图表形如 `owner: { light: ownerLight, dark: ownerDark },`
    for (const key of Object.keys(KEY_GENDER) as PersonArtKey[]) {
      const row = new RegExp(`\\n\\s*${key}: \\{ light: (\\w+), dark: (\\w+) \\}`).exec(table);
      assert.ok(row, `贴图表里没有 ${key} 这一行——选得出 key 却没有图`);
      for (const ident of [row[1]!, row[2]!]) {
        const imp = new RegExp(`import ${ident} from "(\\.\\./assets-profile/people/[^"]+)"`).exec(table);
        assert.ok(imp, `${ident} 没有对应的 import`);
        assert.ok(existsSync(path.join(SRC, "vehicle", imp[1]!)), `素材文件不在：${imp[1]}`);
      }
    }
  });
});
