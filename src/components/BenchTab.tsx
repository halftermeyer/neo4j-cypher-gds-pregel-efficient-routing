import { PerFlowBench, DensityBench, ConcurrencyBench, LoopVsPregelBench, ProvisionBar } from "./BenchParts";
import { Note } from "./ui";
import { BENCH_DB } from "../lib/neo4j";

export default function BenchTab() {
  return (
    <div>
      <Note tone="info">Every benchmark runs in the isolated database <b>{BENCH_DB}</b> with server-side timeouts, so it never touches the demo data. Numbers are measured when you press the button, on this instance, and shown with its size: nothing here is a recorded result.</Note>
      <ProvisionBar />
      <PerFlowBench />
      <DensityBench />
      <ConcurrencyBench />
      <LoopVsPregelBench />
    </div>
  );
}
