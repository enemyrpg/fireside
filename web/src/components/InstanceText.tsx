import { instanceParagraphs } from '@/lib/instance-text';
import { cn } from '@/lib/utils';

// The instance text is plain text: paragraphs separated by a blank line, single
// line breaks kept. It is only ever rendered as React text, never as HTML or
// Markdown, so nothing the admin types can become markup.

export function InstanceText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {instanceParagraphs(text).map((paragraph, index) => (
        // The text never reorders while shown, so the index is a stable key.
        <p key={index} className="m-0 whitespace-pre-line break-words">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
