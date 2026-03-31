export default function EmptyState({ title, description }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-sand-200 py-16 text-center animate-fade-in">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sand-100">
        <span className="text-xl text-sand-400">∅</span>
      </div>
      <p className="text-sm font-medium text-sand-700">{title}</p>
      {description && (
        <p className="mt-1 text-xs text-sand-400">{description}</p>
      )}
    </div>
  );
}
