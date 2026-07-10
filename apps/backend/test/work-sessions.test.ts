import { describe, expect, it } from "vitest";
import { createWorkSession, getPairedReplyExamples, getTodayProgress, migrate, openDatabase, saveFeedback } from "../src/db.js";
import { buildServer, selectEightPostBatch } from "../src/server.js";

describe("work sessions and outcomes", () => {
  it("applies additive migrations idempotently", () => {
    const db=openDatabase(":memory:");
    migrate(db);
    const names=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map((row)=>row.name);
    expect(names).toEqual(expect.arrayContaining(["writing_examples","work_sessions","work_items","outcomes"]));
  });

  it("supports session CRUD, item updates, idempotent outcomes and soft goals", async () => {
    const built=await buildServer({config:{dbPath:":memory:"}});
    const created=await built.app.inject({method:"POST",url:"/api/work-sessions",payload:{title:"Today",softGoal:4}});
    const session=created.json().data;
    const items=await built.app.inject({method:"POST",url:`/api/work-sessions/${session.id}/items`,payload:{posts:[{id:"p1",text:"What tool do you prefer?"}]}});
    const item=items.json().data[0];
    const first=await built.app.inject({method:"POST",url:`/api/work-items/${item.id}/outcomes`,payload:{kind:"used",idempotencyKey:"same"}});
    const second=await built.app.inject({method:"POST",url:`/api/work-items/${item.id}/outcomes`,payload:{kind:"used",idempotencyKey:"same"}});
    expect(first.json().data.created).toBe(true);
    expect(second.json().data.created).toBe(false);
    expect(getTodayProgress(built.db).softGoal).toBe(4);
    expect(getTodayProgress(built.db).completed).toBe(1);
    await built.app.close();
  });

  it("retrieves learned source-to-reply pairs", () => {
    const db=openDatabase(":memory:");
    saveFeedback(db,{suggestionId:"s",kind:"comment",decision:"accepted",finalText:"I prefer the local option.",contextJson:JSON.stringify({sourcePost:{text:"Which local database do you prefer?"}})});
    expect(getPairedReplyExamples(db,"local database choices")).toEqual([{sourceText:"Which local database do you prefer?",replyText:"I prefer the local option."}]);
  });

  it("selects eight posts with three or four easy questions", () => {
    const posts=[
      {id:"q1",text:"What tool do you prefer?"},{id:"q2",text:"Which workflow is your favorite?"},{id:"q3",text:"How was your experience?"},{id:"q4",text:"What would you recommend?"},
      ...Array.from({length:8},(_,i)=>({id:`p${i}`,text:`Observation ${i}`}))
    ];
    const batch=selectEightPostBatch(posts);
    expect(batch).toHaveLength(8);
    expect(batch.filter((post)=>post.text.includes("?"))).toHaveLength(4);
  });
});
