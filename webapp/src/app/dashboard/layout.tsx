import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { requireServerUser } from "@/lib/auth/session";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await requireServerUser();

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="dashboard-theme-main relative flex-1 overflow-y-auto p-4 md:p-6">
          <div aria-hidden className="dashboard-theme-backdrop" />
          <div aria-hidden className="dashboard-theme-noise" />
          <div className="dashboard-theme-content max-w-7xl mx-auto w-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
