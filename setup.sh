#!/bin/bash

# JSOS Setup Script
# This script sets up the development environment

set -e

echo "🚀 JSOS Setup Starting..."
echo "=========================="

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

echo "✅ Docker is running"

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose is not installed. Please install Docker Compose."
    exit 1
fi

echo "✅ Docker Compose is available"

# Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install

echo "✅ npm dependencies installed"

# Build Docker images
echo "🐳 Building Docker images..."
docker-compose build

echo "✅ Docker images built"

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  npm run build     # Build the OS"
echo "  npm run test      # Test the OS"
echo "  npm start         # Show all available commands"
echo ""
echo "Happy coding! 🎯"
