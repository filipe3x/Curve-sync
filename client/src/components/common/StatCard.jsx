export default function StatCard({ label, value, sub, accent = false, title }) {
  return (
    <div className="card animate-fade-in-up" title={title}>
      <p className="text-xs font-medium uppercase tracking-wide text-sand-400">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold ${
          accent ? 'text-curve-700' : 'text-sand-900'
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-sand-400">{sub}</p>}
    </div>
  );
}
