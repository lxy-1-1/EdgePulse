FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md requirements.lock ./
COPY edgepulse ./edgepulse
RUN pip install --no-cache-dir -c requirements.lock . \
    && useradd --uid 10001 --create-home edgepulse \
    && mkdir -p /app/data \
    && chown edgepulse:edgepulse /app/data
USER edgepulse
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)"
CMD ["edgepulse", "serve", "--host", "0.0.0.0"]
