import Sidebar from './Sidebar';

export default function Shell({ children }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto px-6 py-8 lg:px-10">
        <div className="mx-auto max-w-6xl animate-fade-in">
          {children}
        </div>
      </main>
    </div>
  );
}
