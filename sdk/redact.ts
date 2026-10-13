/** Keep login URLs useful in diagnostics without exposing their credentials. */
export function redactCredentials(text: string): string {
    return text
        .replace(/([?&](?:password|token|secret|api[_-]?key)=)[^&#\s"'\\]*/gi, '$1[REDACTED]')
        .replace(/(\b(?:wss?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
