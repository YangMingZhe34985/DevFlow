import { DevflowWorkbench } from "../../../components/devflow-workbench";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <DevflowWorkbench initialRunId={runId} />;
}
