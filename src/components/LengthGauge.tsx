export default function LengthGauge({ length, marker = null, large = false }: { length: number | null; marker?: number | null; large?: boolean }) {
  return <div className={`length-gauge ${large ? 'large' : ''} ${marker && length && marker > length ? 'too-short' : ''}`} role="img" aria-label={`${length ? `${length} ft berth` : 'Shared resource; length not recorded'}${marker ? `; requested length ${marker} ft` : ''}`}>
    <span className="gauge-track"/><span className="gauge-fill" style={{ width: `${length ? Math.min(length / 410 * 100, 100) : 0}%` }}/>
    {marker != null && <span className="gauge-marker" style={{ left: `${Math.min(marker / 410 * 100, 100)}%` }} />}
  </div>;
}
