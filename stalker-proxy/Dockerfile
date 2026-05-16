FROM node:18-slim

WORKDIR /app

# Install dependencies separately for caching
COPY package*.json ./
RUN npm install

# Copy source code (though we will mount it for dev)
COPY . .

EXPOSE 3001

# Run in dev mode with nodemon
CMD ["npm", "run", "dev"]
