import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { EngineTraceView } from '../../engine-trace/EngineTraceView';

describe('EngineTraceView', () => {
    it('renders with empty payload', () => {
        const { container } = render(<EngineTraceView payload={[]} />);
        expect(container.textContent).toContain('Engine Trace Data');
    });

    it('renders cached prefix and history sections', () => {
        const payload = [
            { role: 'system', content: 'You are a GM' },
            { role: 'assistant', content: 'The goblin appears' },
            { role: 'user', content: 'I attack the goblin' },
        ];
        const { container } = render(<EngineTraceView payload={payload} />);
        expect(container.textContent).toContain('Cached Prefix');
        expect(container.textContent).toContain('History');
        expect(container.textContent).toContain('This Turn');
    });

    it('splits volatile context from player input in the final user turn', () => {
        const payload = [
            { role: 'system', content: 'You are a GM' },
            { role: 'assistant', content: 'The goblin appears' },
            { role: 'user', content: '[ARCHIVE RECALL]\nold scene\n\n---\n\nI attack the goblin' },
        ];
        const { container } = render(<EngineTraceView payload={payload} />);
        expect(container.textContent).toContain('VOLATILE CONTEXT');
        expect(container.textContent).toContain('PLAYER INPUT');
    });

    it('keeps spliced GM notes in history position with a label', () => {
        const payload = [
            { role: 'system', content: 'You are a GM' },
            { role: 'assistant', content: 'The goblin appears' },
            { role: 'system', content: '[SCENE NOTE: VOLATILE GUIDANCE]\nbe terse' },
            { role: 'user', content: 'I attack the goblin' },
        ];
        const { container, getByText } = render(<EngineTraceView payload={payload} />);
        // History section is collapsed by default; expand it to reveal the inline GM note.
        fireEvent.click(getByText('History (cached)'));
        expect(container.textContent).toContain('GM NOTE');
    });

    it('renders null payload gracefully', () => {
        const { container } = render(<EngineTraceView payload={null} />);
        expect(container.textContent).toContain('Engine Trace Data');
    });

    it('renders with user and assistant messages', () => {
        const payload = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Welcome' },
        ];
        const { container } = render(<EngineTraceView payload={payload} />);
        expect(container.textContent).toContain('This Turn');
    });
});