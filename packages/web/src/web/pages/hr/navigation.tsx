import { Link, useLocation } from "wouter";
import { useAuth } from "@/components/auth-provider";

const HR_SECTIONS = [
  { label: "Overview", href: "/hr/dashboard" },
  { label: "Attendance", href: "/hr/attendance" },
  { label: "Employees", href: "/hr/employees" },
  { label: "Salary operations", href: "/hr/payroll" },
  { label: "Salary packages", href: "/hr/packages" },
  { label: "Leave", href: "/hr/leave" },
  { label: "Timesheets", href: "/hr/timesheets" },
] as const;

export function HrNavigation() {
  const [location] = useLocation();
  const session = useAuth().session;
  const roles = session?.user.roles?.length ? session.user.roles : session ? [session.user.role] : [];
  const canManageHr = roles.includes("hr") || roles.includes("admin");
  const sections = canManageHr ? HR_SECTIONS : HR_SECTIONS.filter((section) => section.href === "/hr/payroll");
  return (
    <nav aria-label="HR and Payroll sections" className="-mx-1 overflow-x-auto pb-1">
      <div className="flex min-w-max gap-1 border-b border-border px-1">
        {sections.map((section) => {
          const active = location === section.href || location.startsWith(`${section.href}/`);
          return (
            <Link
              key={section.href}
              href={section.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${active ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}`}
            >
              {section.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
