FROM node:20-alpine

WORKDIR /app

# Copiar archivos de configuración
COPY package*.json ./
COPY tsconfig.json ./

# Instalar TODAS las dependencias (incluyendo TypeScript)
RUN npm ci

# Copiar código fuente
COPY src ./src

# Compilar TypeScript
RUN npm run build

# Limpiar devDependencies después de compilar
RUN npm prune --omit=dev

# Exponer puerto
EXPOSE 3001

# Iniciar aplicación compilada
CMD ["node", "dist/index.js"]

