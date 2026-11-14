import { OFFICIAL_SUPPORT } from '../data/uptoskillsKnowledge';

interface BrandMarkProps {
  className?: string;
}

export function BrandMark({ className = '' }: BrandMarkProps) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-md bg-white px-1.5 py-1 ${className}`}>
      <img
        src={OFFICIAL_SUPPORT.logoUrl}
        alt="UpToSkills logo"
        className="h-full w-full object-contain"
        referrerPolicy="no-referrer"
      />
    </span>
  );
}
