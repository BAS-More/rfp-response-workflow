#!/bin/bash
# ============================================================================
# Pre-Sales Engagement Initializer
# ============================================================================
# Usage: ./init.sh <client-name> [tech-stack]
#
# Arguments:
#   client-name   Required. Used as directory name (use kebab-case or PascalCase)
#   tech-stack    Optional. One of: drupal (default), nextjs, react
#
# Examples:
#   ./init.sh Ferrellgas-BlueRhino drupal
#   ./init.sh Acme-Corp nextjs
#   ./init.sh MyClient react
# ============================================================================

set -euo pipefail

# ---- Arguments ----
CLIENT="${1:?Usage: ./init.sh <client-name> [tech-stack]}"
TECH="${2:-drupal}"

# ---- Paths ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRESALES_DIR="$(dirname "$SCRIPT_DIR")"
TARGET="$PRESALES_DIR/$CLIENT"

# ---- Validate tech stack ----
VALID_TECHS=("drupal" "nextjs" "react")
TECH_LOWER="$(echo "$TECH" | tr '[:upper:]' '[:lower:]')"

if [[ ! " ${VALID_TECHS[*]} " =~ " ${TECH_LOWER} " ]]; then
    echo "Error: Invalid tech stack '$TECH'. Must be one of: ${VALID_TECHS[*]}"
    exit 1
fi

# ---- Map tech to display name ----
case "$TECH_LOWER" in
    drupal)  TECH_NAME="Drupal 10/11" ;;
    nextjs)  TECH_NAME="Next.js" ;;
    react)   TECH_NAME="React" ;;
esac

# ---- Check target doesn't exist ----
if [ -d "$TARGET" ]; then
    echo "Error: Directory already exists: $TARGET"
    echo "Remove it first or choose a different client name."
    exit 1
fi

# ---- Copy template ----
echo "Creating engagement: $CLIENT ($TECH_NAME)"
echo "Target: $TARGET"
echo ""

cp -r "$SCRIPT_DIR" "$TARGET"

# ---- Remove init.sh from the copy (it's a template tool, not per-project) ----
rm -f "$TARGET/init.sh"

# ---- Activate tech overlay ----
OVERLAY_FILE="$TARGET/.carl/overlays/${TECH_LOWER}_estimation"
if [ -f "$OVERLAY_FILE" ]; then
    # Copy selected overlay to .carl/ root
    cp "$OVERLAY_FILE" "$TARGET/.carl/${TECH_LOWER}_estimation"

    # Add to manifest
    TECH_UPPER="$(echo "$TECH_LOWER" | tr '[:lower:]' '[:upper:]')"
    cat >> "$TARGET/.carl/manifest" <<EOF

# ============================================================================
# ${TECH_UPPER}_ESTIMATION - Tech-specific rules for ${TECH_NAME}
# ============================================================================
${TECH_UPPER}_ESTIMATION_STATE=active
${TECH_UPPER}_ESTIMATION_ALWAYS_ON=true
EOF
    echo "Activated CARL overlay: ${TECH_LOWER}_estimation"
else
    echo "Warning: No overlay found for '$TECH_LOWER'. Proceeding without tech-specific rules."
fi

# ---- Remove overlays directory (clean up unused overlays) ----
rm -rf "$TARGET/.carl/overlays"

# ---- Replace placeholders in CLAUDE.md ----
TODAY="$(date +%Y-%m-%d)"
# Cross-platform sed -i: BSD needs '' after -i, GNU does not
if sed --version >/dev/null 2>&1; then
    SED_INPLACE=(-i)
else
    SED_INPLACE=(-i '')
fi

sed "${SED_INPLACE[@]}" "s|\[CLIENT_NAME\]|$CLIENT|g" "$TARGET/CLAUDE.md"
sed "${SED_INPLACE[@]}" "s|\[DATE\]|$TODAY|g" "$TARGET/CLAUDE.md"
sed "${SED_INPLACE[@]}" "s|\[TECH_STACK\]|$TECH_NAME|g" "$TARGET/CLAUDE.md"

# Also replace in templates
for tpl in "$TARGET"/templates/*.md; do
    sed "${SED_INPLACE[@]}" "s|\[CLIENT_NAME\]|$CLIENT|g" "$tpl"
    sed "${SED_INPLACE[@]}" "s|\[DATE\]|$TODAY|g" "$tpl"
    sed "${SED_INPLACE[@]}" "s|\[TECH_STACK\]|$TECH_NAME|g" "$tpl"
done

# ---- Initialize git ----
cd "$TARGET"
git init -q
git add -A
git commit -q -m "Initialize presales engagement: $CLIENT ($TECH_NAME)"

echo ""
echo "========================================"
echo "  Engagement initialized successfully!"
echo "========================================"
echo ""
echo "  Client:    $CLIENT"
echo "  Tech:      $TECH_NAME"
echo "  Location:  $TARGET"
echo ""
echo "  Next steps:"
echo "  1. cd $TARGET"
echo "  2. Place TOR/RFP/SOW document(s) in tor/"
echo "  3. Open Claude Code and run Phase 1:"
echo "     \"Analyze the TOR in tor/ and generate clarifying questions\""
echo ""
echo "  Available star-commands:"
echo "    *checklist  — Run estimation gap checklist"
echo "    *recap      — Summarize engagement state"
echo "    *benchmark  — Look up effort benchmarks"
echo ""
