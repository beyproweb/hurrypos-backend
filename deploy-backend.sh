#!/bin/bash
# Backend Deployment Script for Beypro POS
# Deploys printer route fixes to Render production

set -e

echo "🚀 Beypro Backend Deployment"
echo "=============================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check if in correct directory
if [ ! -f "server.js" ]; then
    echo -e "${RED}❌ Error: Not in hurrypos-backend directory${NC}"
    echo "Please run from: /Users/nurikord/PycharmProjects/hurrypos-backend"
    exit 1
fi

echo -e "${GREEN}✅ In hurrypos-backend directory${NC}"
echo ""

# Display deployment options
echo -e "${BLUE}Deployment Options:${NC}"
echo "1. Deploy to Render (production)"
echo "2. Deploy local changes only"
echo "3. Test deployment (no push)"
echo "4. View deployment status"
echo ""

read -p "Choose option (1-4): " choice

case $choice in
    1)
        echo ""
        echo -e "${YELLOW}📤 Preparing production deployment to Render${NC}"
        echo ""
        
        # Step 1: Verify changes
        echo "1️⃣ Checking modified files..."
        echo ""
        
        if [ -z "$(git status --porcelain)" ]; then
            echo -e "${YELLOW}⚠️  No uncommitted changes detected${NC}"
            read -p "Continue anyway? (y/n): " confirm
            if [ "$confirm" != "y" ]; then
                echo -e "${RED}❌ Deployment cancelled${NC}"
                exit 1
            fi
        else
            echo -e "${YELLOW}Modified files:${NC}"
            git status --short | head -20
            echo ""
            
            read -p "Commit these changes? (y/n): " commit_changes
            if [ "$commit_changes" = "y" ]; then
                echo "Enter commit message: "
                read commit_msg
                git add -A
                git commit -m "$commit_msg"
                echo -e "${GREEN}✅ Changes committed${NC}"
            fi
        fi
        
        echo ""
        echo "2️⃣ Verifying critical files..."
        
        # Check key files modified
        if [ -f "routes/printer.js" ]; then
            echo -e "${GREEN}✅ routes/printer.js exists${NC}"
        fi
        
        if grep -q "probeTcpWithFingerprint" routes/printer.js; then
            echo -e "${GREEN}✅ ESC/POS fingerprinting found${NC}"
        fi
        
        if grep -q "discover-network" routes/printer.js; then
            echo -e "${GREEN}✅ Network discovery endpoint found${NC}"
        fi
        
        echo ""
        echo "3️⃣ Pushing to GitHub (triggers Render deploy)..."
        echo ""
        
        # Get current branch
        BRANCH=$(git rev-parse --abbrev-ref HEAD)
        echo -e "${BLUE}Current branch: $BRANCH${NC}"
        
        # Verify branch is main
        if [ "$BRANCH" != "main" ]; then
            echo -e "${YELLOW}⚠️  Not on main branch${NC}"
            read -p "Switch to main and push? (y/n): " switch_branch
            if [ "$switch_branch" = "y" ]; then
                git checkout main
                BRANCH="main"
            else
                echo -e "${RED}❌ Deployment requires main branch${NC}"
                exit 1
            fi
        fi
        
        echo "Pushing to GitHub..."
        git push origin $BRANCH
        
        echo ""
        echo -e "${GREEN}✅ Push successful${NC}"
        echo ""
        echo "🔗 Render will automatically deploy changes"
        echo ""
        echo -e "${BLUE}Monitor deployment at:${NC}"
        echo "   https://dashboard.render.com"
        echo ""
        echo -e "${BLUE}Backend API endpoint:${NC}"
        echo "   https://api.beypro.com/api"
        echo ""
        echo "⏱️  Expected deployment time: 2-5 minutes"
        ;;
        
    2)
        echo ""
        echo -e "${YELLOW}📝 Deploying local changes only${NC}"
        echo ""
        
        # Check for uncommitted changes
        if [ -z "$(git status --porcelain)" ]; then
            echo -e "${YELLOW}⚠️  No local changes to deploy${NC}"
            exit 0
        fi
        
        echo "Modified files:"
        git status --short
        echo ""
        
        read -p "Commit and deploy? (y/n): " confirm
        if [ "$confirm" = "y" ]; then
            echo "Enter commit message: "
            read commit_msg
            git add -A
            git commit -m "$commit_msg"
            git push origin main
            echo -e "${GREEN}✅ Changes deployed${NC}"
        fi
        ;;
        
    3)
        echo ""
        echo -e "${YELLOW}🧪 Test deployment (dry-run)${NC}"
        echo ""
        
        # Verify connectivity
        echo "Testing backend connectivity..."
        if curl -s https://api.beypro.com/api/printer-settings/status > /dev/null; then
            echo -e "${GREEN}✅ Backend is online${NC}"
        else
            echo -e "${RED}❌ Backend is offline${NC}"
        fi
        
        echo ""
        echo "Testing Git repository..."
        if git remote -v | grep -q origin; then
            echo -e "${GREEN}✅ Git remote configured${NC}"
            git remote -v | grep origin
        fi
        
        echo ""
        echo "Testing files..."
        if [ -f "server.js" ] && [ -f "routes/printer.js" ]; then
            echo -e "${GREEN}✅ Key files present${NC}"
        fi
        
        echo ""
        echo "Deployment test complete. Use option 1 to deploy."
        ;;
        
    4)
        echo ""
        echo -e "${BLUE}📊 Deployment Status${NC}"
        echo ""
        
        echo "Git Status:"
        echo "  Branch: $(git rev-parse --abbrev-ref HEAD)"
        echo "  Commits behind origin: $(git rev-list --count HEAD..origin/main)"
        echo ""
        
        echo "Modified files:"
        if [ -z "$(git status --porcelain)" ]; then
            echo "  None"
        else
            git status --short | sed 's/^/  /'
        fi
        
        echo ""
        echo "Backend connectivity:"
        if curl -s https://api.beypro.com/api/printer-settings/status > /dev/null 2>&1; then
            echo -e "  ${GREEN}✅ Online${NC}"
        else
            echo -e "  ${RED}❌ Offline${NC}"
        fi
        
        echo ""
        echo "Last commit:"
        git log -1 --oneline | sed 's/^/  /'
        ;;
        
    *)
        echo -e "${RED}❌ Invalid option${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✨ Done!${NC}"
