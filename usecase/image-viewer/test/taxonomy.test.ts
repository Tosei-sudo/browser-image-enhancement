import { describe, expect, it } from "vitest";
import {
  flows,
  nextName,
  observationsCsv,
  observationStoreOf,
  vocabularyOf,
  type Observation,
} from "../src/observations.js";
import {
  childrenOf,
  EsriTaxonomyStore,
  flatten,
  kindOf,
  levelName,
  memberIndex,
  moveTaxon,
  nameLabelOf,
  nest,
  pathOf,
  removeTaxon,
  rewrite,
  taxonomyOf,
  updateTaxon,
  withKinds,
  within,
  type TaxonTree,
} from "../src/taxonomy.js";

// Ships four deep (the individual below), aircraft three: each branch names its own levels.
const tree: TaxonTree[] = [
  {
    name: "船舶",
    levels: ["大分類", "艦種", "級"],
    nameLabel: "艦名",
    children: [
      { name: "支援船", children: [{ name: "〇〇級", members: ["△△", "□□"] }] },
      { name: "護衛艦" },
    ],
  },
  {
    name: "航空機",
    levels: ["大分類", "型式"],
    nameLabel: "機番",
    children: [
      {
        name: "F-15",
        children: [{ name: "F-15J", levels: ["大分類", "型式", "派生型"] }],
      },
    ],
  },
];

describe("taxonomy", () => {
  it("reads and writes kinds as paths", () => {
    expect(pathOf("船舶 > 支援船 >〇〇級")).toEqual([
      "船舶",
      "支援船",
      "〇〇級",
    ]);
    expect(pathOf("船舶 › 支援船")).toEqual(["船舶", "支援船"]);
    expect(kindOf(["船舶", "支援船"])).toBe("船舶 > 支援船");
    expect(within("船舶 > 支援船 > 〇〇級", ["船舶", "支援船"])).toBe(true);
    expect(within("船舶 > 支援船x", ["船舶", "支援船"])).toBe(false);
    expect(within("船舶", ["船舶", "支援船"])).toBe(false);
  });

  it("flattens a nested tree, parents first, and nests it back", () => {
    const list = flatten(tree);
    expect(list.map((t) => kindOf(t.path))).toEqual([
      "船舶",
      "船舶 > 支援船",
      "船舶 > 支援船 > 〇〇級",
      "船舶 > 護衛艦",
      "航空機",
      "航空機 > F-15",
      "航空機 > F-15 > F-15J",
    ]);
    expect(nest(list)).toEqual(tree);
    expect(childrenOf(list, ["船舶"]).map((t) => t.path[1])).toEqual([
      "支援船",
      "護衛艦",
    ]);
    expect(childrenOf(list, []).map((t) => t.path[0])).toEqual([
      "船舶",
      "航空機",
    ]);
  });

  it("names levels per branch, the nearest class that says winning", () => {
    const list = flatten(tree);
    expect(levelName(list, ["船舶", "支援船", "〇〇級"], 2)).toBe("級");
    expect(levelName(list, ["船舶", "支援船"], 1)).toBe("艦種");
    expect(levelName(list, ["航空機", "F-15"], 1)).toBe("型式");
    expect(levelName(list, ["航空機", "F-15", "F-15J"], 2)).toBe("派生型");
    expect(levelName(list, ["航空機", "F-15"], 2)).toBe("");
    expect(nameLabelOf(list, ["船舶", "支援船", "〇〇級"])).toBe("艦名");
    expect(nameLabelOf(list, ["航空機", "F-15"])).toBe("機番");
    expect(memberIndex(list).get("△△")).toEqual(["船舶", "支援船", "〇〇級"]);
  });

  it("moves, renames, changes and removes a class with its branch", () => {
    const list = flatten(tree);
    const moved = moveTaxon(list, ["船舶", "支援船"], ["船舶", "補助艦"]);
    expect(moved.map((t) => kindOf(t.path))).toContain(
      "船舶 > 補助艦 > 〇〇級",
    );
    expect(moved.map((t) => kindOf(t.path))).not.toContain("船舶 > 支援船");
    expect(() =>
      moveTaxon(list, ["船舶"], ["船舶", "支援船", "船舶"]),
    ).toThrow();
    expect(
      rewrite("船舶 > 支援船 > 〇〇級", ["船舶", "支援船"], ["船舶", "補助艦"]),
    ).toBe("船舶 > 補助艦 > 〇〇級");
    expect(rewrite("航空機", ["船舶"], ["x"])).toBe("航空機");
    const changed = updateTaxon(list, ["船舶", "護衛艦"], {
      members: ["あ", "あ", "い"],
      nameLabel: "艦名",
    });
    expect(changed.find((t) => t.path[1] === "護衛艦")).toEqual({
      path: ["船舶", "護衛艦"],
      members: ["あ", "い"],
      nameLabel: "艦名",
    });
    expect(
      removeTaxon(list, ["船舶", "支援船"]).map((t) => kindOf(t.path)),
    ).toEqual([
      "船舶",
      "船舶 > 護衛艦",
      "航空機",
      "航空機 > F-15",
      "航空機 > F-15 > F-15J",
    ]);
  });

  it("adds the kinds records use, under their classes", () => {
    const list = withKinds(flatten(tree), [
      "船舶 > 支援船 > ××級",
      "車両 > 戦車",
      "",
    ]);
    expect(list.map((t) => kindOf(t.path))).toEqual([
      "船舶",
      "船舶 > 支援船",
      "船舶 > 支援船 > 〇〇級",
      "船舶 > 支援船 > ××級",
      "船舶 > 護衛艦",
      "航空機",
      "航空機 > F-15",
      "航空機 > F-15 > F-15J",
      "車両",
      "車両 > 戦車",
    ]);
  });

  it("reads config.json, plain names too, and says what is wrong", () => {
    const problems: string[] = [];
    const list = taxonomyOf(
      ["車両", { name: "船舶", children: ["漁船", { bogus: 1 }] }],
      problems,
    )!;
    expect(list.map((t) => kindOf(t.path))).toEqual([
      "車両",
      "船舶",
      "船舶 > 漁船",
    ]);
    expect(problems).toEqual([
      "observationTaxonomy[1].children[1] は name のある分類（または名前の文字列）で指定",
    ]);
    expect(taxonomyOf({}, problems)).toBeNull();
    const v = vocabularyOf({ taxonomy: tree, activities: ["入港"] }, []);
    expect(v.kinds).toEqual(["船舶", "航空機"]);
    expect(v.taxonomy.length).toBe(7);
    // Plain kinds of before stay roots.
    expect(vocabularyOf({ kinds: ["艦艇"] }, []).taxonomy).toEqual([
      { path: ["艦艇"] },
    ]);
    const store = observationStoreOf(
      {
        url: "https://x/FeatureServer/0",
        taxonomy: tree,
        taxonomyTable: "https://x/FeatureServer/3",
      },
      problems,
      0,
    )!;
    expect(store.taxonomy?.length).toBe(7);
    expect(store.taxonomyTable).toEqual({
      url: "https://x/FeatureServer/3",
      fields: {
        path: "PATH",
        levels: "LEVELS",
        nameLabel: "NAME_LABEL",
        members: "MEMBERS",
        order: "SORT_ORDER",
      },
    });
  });
});

const obs = (o: Partial<Observation>): Observation => ({
  id: Math.random().toString(36),
  imageId: "img",
  imageName: "img.tif",
  imageTime: 1,
  objectId: "A",
  objectName: "△△",
  kind: "船舶",
  activity: "停泊",
  present: true,
  note: "",
  lon: 139.7,
  lat: 35.6,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...o,
});

describe("kinds in observations", () => {
  it("keeps a thing as deep as any record knows it", () => {
    const [flow] = flows([
      obs({ imageTime: 1, kind: "船舶 > 支援船 > 〇〇級" }),
      obs({ imageTime: 2, kind: "船舶" }),
    ]);
    expect(flow.kind).toBe("船舶 > 支援船 > 〇〇級");
    // A later record that says another class wins.
    const [moved] = flows([
      obs({ imageTime: 1, kind: "船舶 > 支援船 > 〇〇級" }),
      obs({ imageTime: 2, kind: "船舶 > 護衛艦" }),
    ]);
    expect(moved.kind).toBe("船舶 > 護衛艦");
  });

  it("numbers new things by their deepest class, and writes a CSV column per level", () => {
    expect(nextName("船舶 > 支援船 > 〇〇級", ["〇〇級-1"])).toBe("〇〇級-2");
    const csv = observationsCsv([
      obs({ kind: "船舶 > 支援船 > 〇〇級" }),
      obs({ kind: "航空機" }),
    ]);
    expect(csv.split("\r\n")[0]).toContain("種別,分類1,分類2,分類3,活動");
    expect(csv).toContain("船舶 > 支援船 > 〇〇級,船舶,支援船,〇〇級,停泊");
    expect(csv).toContain("航空機,航空機,,,停泊");
  });
});

describe("EsriTaxonomyStore", () => {
  it("writes a row per class and deletes the rows of classes gone", async () => {
    const calls: Array<{ url: string; params: Record<string, string> }> = [];
    let next = 10;
    const ask = async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith("/3"))
        return {
          objectIdField: "OBJECTID",
          fields: ["OBJECTID", "PATH", "LEVELS", "MEMBERS", "SORT_ORDER"].map(
            (name) => ({
              name,
              type:
                name === "OBJECTID"
                  ? "esriFieldTypeOID"
                  : "esriFieldTypeString",
            }),
          ),
        };
      if (url.endsWith("/query"))
        return {
          features: [
            {
              attributes: {
                OBJECTID: 1,
                PATH: "船舶 > 支援船",
                LEVELS: "大分類,艦種",
                MEMBERS: "",
                SORT_ORDER: 1,
              },
            },
            {
              attributes: {
                OBJECTID: 2,
                PATH: "船舶",
                LEVELS: "大分類,艦種",
                SORT_ORDER: 0,
              },
            },
          ],
        };
      const adds = JSON.parse(params.adds) as unknown[];
      return {
        addResults: adds.map(() => ({ success: true, objectId: next++ })),
        updateResults: (JSON.parse(params.updates) as unknown[]).map(() => ({
          success: true,
        })),
      };
    };
    const store = new EsriTaxonomyStore(
      {
        url: "https://x/FeatureServer/3",
        fields: {
          path: "PATH",
          levels: "LEVELS",
          nameLabel: "NAME_LABEL",
          members: "MEMBERS",
          order: "SORT_ORDER",
        },
      },
      ask,
      "分類",
    );
    const list = (await store.load())!;
    expect(list.map((t) => kindOf(t.path))).toEqual(["船舶", "船舶 > 支援船"]);
    expect(list[0].levels).toEqual(["大分類", "艦種"]);
    await store.save([
      { path: ["船舶"] },
      { path: ["航空機"], members: ["A", "B"] },
    ]);
    const edit = calls[calls.length - 1].params;
    expect(edit.deletes).toBe("1");
    expect(JSON.parse(edit.updates)).toEqual([
      {
        attributes: {
          PATH: "船舶",
          LEVELS: "",
          MEMBERS: "",
          SORT_ORDER: 0,
          OBJECTID: 2,
        },
      },
    ]);
    // NAME_LABEL is not in the table: left out.
    expect(JSON.parse(edit.adds)).toEqual([
      {
        attributes: {
          PATH: "航空機",
          LEVELS: "",
          MEMBERS: "A,B",
          SORT_ORDER: 1,
        },
      },
    ]);
  });
});
