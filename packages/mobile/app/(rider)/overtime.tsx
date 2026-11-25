import { useQuery } from "@tanstack/react-query";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Panel } from "../../components/natex/card";
import { Body, Label, Small } from "../../components/natex/text";
import { orpc } from "../../lib/api";
export default function RiderOvertimeScreen() {
  const year = new Date().getFullYear();
  const summary = useQuery(orpc.hr.riderAttendanceSummary.queryOptions({ input: { year } }));
  const month = new Date().getMonth() + 1;
  const hours = (summary.data?.rows ?? []).reduce((total, row) => total + Number((row as { overtimeHours?: number }).overtimeHours ?? 0), 0);
  return <Screen><ScreenHeader title="Over-time earning" subtitle="Approved attendance and overtime summary" /><Panel><Label>THIS MONTH</Label><Body>{hours.toFixed(2)} hours</Body><Small>Month {month} · {year}</Small></Panel><Panel><Label>APPROVAL</Label><Body>Overtime is calculated from approved attendance.</Body><Small>Eligible time is sent to HR for approval before it becomes payable.</Small></Panel></Screen>;
}
