FROM node:18-slim

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node/app

# Install dependencies separately for caching
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

EXPOSE 3001

# Run in dev mode with nodemon
CMD ["npm", "run", "dev"]
