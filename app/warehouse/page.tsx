import { connection } from "next/server";
import { WarehouseWorkspace } from "@/components/warehouse/warehouse-workspace";
import { requireWarehouseSession } from "@/lib/auth/authorization";
import { getWarehouseWorkspaceData } from "@/services/warehouse-workspace";

export const dynamic = "force-dynamic";

export default async function WarehousePage() {
  const session = await requireWarehouseSession();
  await connection();
  const data = await getWarehouseWorkspaceData(session.username);
  return <WarehouseWorkspace user={{ displayName: session.displayName, username: session.username }} initialData={data}/>;
}
