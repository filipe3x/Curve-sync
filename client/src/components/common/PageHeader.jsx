export default function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-8 flex items-start justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-sand-900">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-sand-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex gap-3">{actions}</div>}
    </div>
  );
}
