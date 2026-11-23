import { Link, useLocation } from "wouter";
import { useAuth } from "@/components/auth-provider";

const HR_SECTIONS = [
  { label: "Dashboard", href: "/hr/dashboard" },
  { label: "Employees", href: "/hr/employees" },
  { label: "Attendance", href: "/hr/attendance" },
  { label: "Leave", href: "/hr/leave" },
  { label: "Calendar & payout", href: "/hr/calendar" },
  { label: "Salary operations", href: "/hr/payroll" },
  { label: "Salary packages", href: "/hr/packages" },
  { label: "Payslips", href: "/hr/payslips" },
  { label: "Timesheets", href: "/hr/timesheets" },
  { label: "Attendance sheet", href: "/hr/attendance-management" },
  { label: "Approvals", href: "/hr/approvals" },
  { label: "Terminations", href: "/hr/terminations" },
] as const;

function SectionRow({ title, sections, location }: { title: string; sections: readonly { label: string; href: string }[]; location: string }) {
  return <div className="flex min-w-max items-center gap-1 border-b border-border px-1"><span className="mr-2 px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{title}</span>{sections.map((section) => {
    const active = location === section.href || location.startsWith(`${section.href}/`);
    return <Link key={section.href} href={section.href} aria-current={active ? "page" : undefined} className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${active ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}`}>{section.label}</Link>;
  })}</div>;
}

export function HrNavigation() {
  const [location] = useLocation();
  const session = useAuth().session;
  const roles = session?.user.roles?.length ? session.user.roles : session ? [session.user.role] : [];
  const canManageHr = roles.includes("hr") || roles.includes("admin");
  const canSeePayroll = canManageHr || roles.includes("finance");
  return <nav aria-label="HR and Payroll sections" className="-mx-1 overflow-x-auto pb-1"><div className="flex min-w-max flex-col">{canManageHr ? <SectionRow title="HR & Payroll" sections={HR_SECTIONS} location={location} /> : canSeePayroll ? <SectionRow title="HR & Payroll" sections={HR_SECTIONS.filter((section) => ["/hr/payroll", "/hr/payslips"].includes(section.href))} location={location} /> : null}</div></nav>;
}
