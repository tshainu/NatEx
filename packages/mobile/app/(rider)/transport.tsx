import { useQuery } from "@tanstack/react-query";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Panel } from "../../components/natex/card";
import { Body, Label, Small } from "../../components/natex/text";
import { orpc } from "../../lib/api";
export default function RiderTransportScreen() {
  const today = useQuery(orpc.collection.riderToday.queryOptions({ input: {} }));
  const items = today.data?.manifests ?? [];
  return <Screen><ScreenHeader title="Transport" subtitle="Your active transport and run status" /><Panel><Label>ACTIVE RUN</Label><Body>{items.length ? `${items.length} parcel${items.length === 1 ? "" : "s"} currently assigned` : "No active transport assignment"}</Body><Small>Transport assignments for your branch appear here when dispatched.</Small></Panel><Panel><Label>STATUS</Label><Body>{items.length ? "In progress" : "Awaiting assignment"}</Body></Panel></Screen>;
}
