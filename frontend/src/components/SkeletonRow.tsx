/**
 * Skeleton loader for table rows.
 */
import React from 'react';

interface SkeletonRowProps {
    readonly cols: number;
}

/**
 * Renders a table row of skeleton cells.
 */
export function SkeletonRow({ cols }: SkeletonRowProps): React.ReactElement {
    return (
        <tr>
            {Array.from({ length: cols }, (_, i) => (
                <td key={i} style={{ padding: '14px 16px' }}>
                    <div
                        className="skeleton"
                        style={{
                            height: '18px',
                            width: i === 0 ? '60%' : i === cols - 1 ? '40%' : '80%',
                        }}
                    />
                </td>
            ))}
        </tr>
    );
}

/**
 * Skeleton for a card-style content block.
 */
export function SkeletonBlock({ height = 80 }: { readonly height?: number }): React.ReactElement {
    return (
        <div
            className="skeleton"
            style={{ height: `${height}px`, borderRadius: 'var(--radius-md)' }}
        />
    );
}
