FROM node:20-slim

WORKDIR /app

# Install dependencies separately for caching
COPY package*.json ./
RUN npm install

# Copy source code (though we will mount it for dev)
COPY . .

EXPOSE 5173

# Run Vite dev server, allowing host connection
CMD ["npm", "run", "dev", "--", "--host"]
